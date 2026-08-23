import fs from 'fs';
import path from 'path';
import type { BrowserWindow } from 'electron';
import { debug as logDebug } from '../log.js';
import {
  AskCodeSession,
  ASK_CODE_MAX_CONCURRENT,
  ASK_CODE_TIMEOUT_MS,
  RequestRegistry,
  assertCanStart,
  assertPromptWithinLimit,
} from './request-registry.js';

interface MinimaxAskCodeRequest {
  requestId: string;
  channelId: string;
  prompt: string;
  /**
   * Absolute paths of images to send alongside the prompt. The app already
   * resolves pasted and dropped images to temp files, so a request carries
   * those paths rather than the bytes themselves.
   */
  imagePaths?: string[];
}

const MINIMAX_API_URL = 'https://api.minimax.io/v1/chat/completions';
export const MINIMAX_MODEL = 'MiniMax-M2.7';

/** Model used when a request carries image input. */
export const MINIMAX_IMAGE_INPUT_MODEL = 'MiniMax-M3';

/** Input modalities a MiniMax model accepts. */
export type MinimaxInputModality = 'text' | 'image' | 'video';

/** Input modalities per model, as published in the provider model catalog. */
const MINIMAX_INPUT_MODALITIES: Readonly<Record<string, readonly MinimaxInputModality[]>> = {
  [MINIMAX_IMAGE_INPUT_MODEL]: ['text', 'image', 'video'],
  [MINIMAX_MODEL]: ['text'],
};

/** Whether a model accepts image input according to the catalog. */
export function minimaxModelAcceptsImages(modelId: string): boolean {
  return MINIMAX_INPUT_MODALITIES[modelId]?.includes('image') ?? false;
}

/** Image input is capped separately from the prompt: the bytes never count against it. */
const MAX_IMAGES_PER_REQUEST = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** A chat message content part in the chat completions request schema. */
type MinimaxContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Picks the model for a request. Image input requires a model whose catalog
 * modalities include images, so image requests fall back to the image-capable
 * model whenever the text default cannot accept them.
 */
function resolveModel(hasImages: boolean): string {
  if (!hasImages || minimaxModelAcceptsImages(MINIMAX_MODEL)) return MINIMAX_MODEL;
  return MINIMAX_IMAGE_INPUT_MODEL;
}

/** Rejects unsupported or oversized image input before a request is started. */
function assertImagesSupported(imagePaths: string[]): void {
  if (imagePaths.length > MAX_IMAGES_PER_REQUEST) {
    throw new Error(
      `Too many images (${imagePaths.length}, max ${MAX_IMAGES_PER_REQUEST} per question)`,
    );
  }
  for (const imagePath of imagePaths) {
    if (!IMAGE_MIME_TYPES[path.extname(imagePath).toLowerCase()]) {
      throw new Error(`Unsupported image type: ${path.basename(imagePath)}`);
    }
  }
}

/** Reads an image from disk into the data URL form the chat API expects. */
async function imageDataUrl(imagePath: string): Promise<string> {
  const mimeType = IMAGE_MIME_TYPES[path.extname(imagePath).toLowerCase()];
  if (!mimeType) throw new Error(`Unsupported image type: ${path.basename(imagePath)}`);

  const bytes = await fs.promises.readFile(imagePath);
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image too large: ${path.basename(imagePath)} (${bytes.byteLength} bytes, max ${MAX_IMAGE_BYTES})`,
    );
  }
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

/**
 * Builds the user message content: a plain string while the question is text
 * only, and text plus image parts once images are attached.
 */
async function buildUserContent(
  prompt: string,
  imagePaths: string[],
): Promise<string | MinimaxContentPart[]> {
  if (imagePaths.length === 0) return prompt;

  const parts: MinimaxContentPart[] = [{ type: 'text', text: prompt }];
  for (const imagePath of imagePaths) {
    parts.push({ type: 'image_url', image_url: { url: await imageDataUrl(imagePath) } });
  }
  return parts;
}

const activeRequests = new RequestRegistry<AbortController>({
  maxConcurrent: ASK_CODE_MAX_CONCURRENT,
  timeoutMs: ASK_CODE_TIMEOUT_MS,
});

/** Main-process storage for the MiniMax API key. Never sent back to the renderer. */
let storedApiKey = '';

export function setMinimaxApiKey(key: string): void {
  storedApiKey = key.trim();
}

export function askAboutCodeMinimax(win: BrowserWindow, args: MinimaxAskCodeRequest): void {
  const { requestId, channelId, prompt } = args;
  const imagePaths = args.imagePaths ?? [];
  const apiKey = storedApiKey;

  if (!apiKey) {
    throw new Error('MiniMax API key is not set. Please configure it in Settings.');
  }

  assertPromptWithinLimit(prompt);
  assertImagesSupported(imagePaths);
  assertCanStart(activeRequests, requestId);

  cancelAskAboutCodeMinimax(requestId);

  const model = resolveModel(imagePaths.length > 0);

  const controller = new AbortController();

  const send = (msg: unknown) => {
    if (!win.isDestroyed()) {
      win.webContents.send(`channel:${channelId}`, msg);
    }
  };

  const session = AskCodeSession.start(activeRequests, requestId, controller, send, (request) =>
    request.abort(),
  );

  buildUserContent(prompt, imagePaths)
    .then((content) =>
      fetch(MINIMAX_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: 'Answer concisely about the selected code. Use markdown.',
            },
            { role: 'user', content },
          ],
          // MiniMax temperature must be in (0.0, 1.0]
          temperature: 0.3,
          max_tokens: 2048,
          stream: true,
        }),
        signal: controller.signal,
      }),
    )
    .then(async (res) => {
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(`MiniMax API error (${res.status}): ${text}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      // When the AbortController fires, cancel the reader so reader.read() resolves
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        reader.cancel().catch((err) => {
          logDebug('askCode.minimax', 'reader.cancel rejected', { err: String(err) });
        });
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || aborted) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            if (!trimmed.startsWith('data:')) continue;
            try {
              const json = JSON.parse(trimmed.slice(5).trim()) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) send({ type: 'chunk', text: delta });
            } catch {
              // ignore parse errors in SSE stream
            }
          }
        }
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
      }

      session.cleanup();
      if (session.complete()) {
        send({ type: 'done', exitCode: 0, cancelled: aborted });
      }
    })
    .catch((err: unknown) => {
      session.cleanup();
      if (session.complete()) {
        if (err instanceof Error && err.name === 'AbortError') {
          // request was cancelled — send done without error, neutral exit code
          send({ type: 'done', exitCode: 0, cancelled: true });
        } else {
          send({ type: 'error', text: err instanceof Error ? err.message : String(err) });
          send({ type: 'done', exitCode: 1 });
        }
      }
    });
}

export function cancelAskAboutCodeMinimax(requestId: string): void {
  activeRequests.cancel(requestId);
}

export function isMinimaxRequestActive(requestId: string): boolean {
  return activeRequests.has(requestId);
}
