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
import { askCodeImageMimeTypeForPath } from './ask-code-image.js';

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

/** Image input is capped separately from the prompt: the bytes never count against it. */
const MAX_IMAGES_PER_REQUEST = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Keep base64 data plus JSON framing below the provider's 64 MB body limit.
const MAX_TOTAL_IMAGE_BYTES = 46 * 1024 * 1024;

/** A chat message content part in the chat completions request schema. */
type MinimaxContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** Rejects unsupported or oversized image input before a request is started. */
function assertImagesSupported(imagePaths: string[]): void {
  if (imagePaths.length > MAX_IMAGES_PER_REQUEST) {
    throw new Error(
      `Too many images (${imagePaths.length}, max ${MAX_IMAGES_PER_REQUEST} per question)`,
    );
  }
  for (const imagePath of imagePaths) {
    if (!askCodeImageMimeTypeForPath(imagePath)) {
      throw new Error(`Unsupported image type: ${path.basename(imagePath)}`);
    }
  }
}

/** Identify supported image bytes without trusting the file extension. */
function detectImageMimeType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const header = bytes.subarray(0, 12).toString('ascii');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

/** Check individual and aggregate sizes before buffering image data. */
async function assertImageSizes(imagePaths: string[]): Promise<void> {
  let totalBytes = 0;
  for (const imagePath of imagePaths) {
    const { size } = await fs.promises.stat(imagePath);
    if (size > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image too large: ${path.basename(imagePath)} (${size} bytes, max ${MAX_IMAGE_BYTES})`,
      );
    }
    totalBytes += size;
  }
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error(`Attached images are too large (${totalBytes} bytes total)`);
  }
}

/** Reads an image from disk into the data URL form the chat API expects. */
async function imageDataUrl(imagePath: string): Promise<string> {
  const bytes = await fs.promises.readFile(imagePath);
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) throw new Error(`Unsupported image data: ${path.basename(imagePath)}`);
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
  await assertImageSizes(imagePaths);

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

  const model = imagePaths.length > 0 ? MINIMAX_IMAGE_INPUT_MODEL : MINIMAX_MODEL;

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
