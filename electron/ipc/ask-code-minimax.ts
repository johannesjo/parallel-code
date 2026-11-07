import type { BrowserWindow } from 'electron';
import { debug as logDebug } from '../log.js';
import { ASK_CODE_MODELS } from '../shared/ask-code-models.js';
import { UNDERSTANDING_MAX_OUTPUT_CHARS } from '../shared/understanding-limits.js';
import {
  askCodePromptLimit,
  askCodeSystemPrompt,
  askCodeTimeoutMs,
  isStructuredPurpose,
  type AskCodePurpose,
} from './ask-code-purpose.js';
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
  purpose?: AskCodePurpose;
  model?: string;
}

const MINIMAX_API_URL = 'https://api.minimax.io/v1/chat/completions';
/** Inline answers stay short; a tour JSON object with up to 8 cards needs far more room. */
const MAX_TOKENS_INLINE = 2048;
/**
 * Ceiling, not a target: the largest tour the validator accepts, at a
 * conservative ~3 characters per token so a dense JSON response still fits.
 */
const MAX_TOKENS_STRUCTURED = Math.ceil(UNDERSTANDING_MAX_OUTPUT_CHARS / 3);
export const MINIMAX_MODEL = ASK_CODE_MODELS.minimax;

interface ThinkingFilterState {
  insideThinking: boolean;
  pending: string;
}

/** Remove inline reasoning tags, including tags split across SSE deltas. */
function visibleMinimaxContent(delta: string, state: ThinkingFilterState): string {
  let text = state.pending + delta;
  state.pending = '';
  let visible = '';

  while (text) {
    const tag = state.insideThinking ? '</think>' : '<think>';
    const tagIndex = text.indexOf(tag);
    if (tagIndex >= 0) {
      if (!state.insideThinking) visible += text.slice(0, tagIndex);
      text = text.slice(tagIndex + tag.length);
      state.insideThinking = !state.insideThinking;
      continue;
    }

    let pendingLength = 0;
    for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) {
      if (tag.startsWith(text.slice(-length))) {
        pendingLength = length;
        break;
      }
    }
    const complete = text.slice(0, text.length - pendingLength);
    if (!state.insideThinking) visible += complete;
    state.pending = text.slice(text.length - pendingLength);
    break;
  }

  return visible;
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
  const apiKey = storedApiKey;
  const model = args.model ?? MINIMAX_MODEL;
  const isFlash = model === 'MiniMax-M3.1-Flash';
  const isM3 = model === 'MiniMax-M3';

  if (!apiKey) {
    throw new Error('MiniMax API key is not set. Please configure it in Settings.');
  }

  assertPromptWithinLimit(prompt, askCodePromptLimit(args.purpose));
  assertCanStart(activeRequests, requestId);

  cancelAskAboutCodeMinimax(requestId);

  const controller = new AbortController();

  const send = (msg: unknown) => {
    if (!win.isDestroyed()) {
      win.webContents.send(`channel:${channelId}`, msg);
    }
  };

  const session = AskCodeSession.start(
    activeRequests,
    requestId,
    controller,
    send,
    (request) => request.abort(),
    askCodeTimeoutMs(args.purpose),
  );

  fetch(MINIMAX_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      // Flash always thinks; keep reasoning separate from answers and tour JSON.
      ...(isFlash
        ? { thinking: { type: 'adaptive' }, reasoning_effort: 'low' }
        : isM3
          ? { thinking: { type: 'disabled' } }
          : {}),
      // M2.7 and custom model ids can otherwise return <think> blocks in content.
      reasoning_split: true,
      messages: [
        { role: 'system', content: askCodeSystemPrompt(args.purpose) },
        { role: 'user', content: prompt },
      ],
      // MiniMax temperature must be in (0.0, 1.0]
      temperature: 0.3,
      // Thinking counts toward the budget. Flash needs room beyond a short answer.
      max_tokens: isStructuredPurpose(args.purpose)
        ? MAX_TOKENS_STRUCTURED
        : isFlash
          ? 16_384
          : MAX_TOKENS_INLINE,
      stream: true,
    }),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(`MiniMax API error (${res.status}): ${text}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const thinkingFilter: ThinkingFilterState = { insideThinking: false, pending: '' };

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
        readStream: while (true) {
          const { done, value } = await reader.read();
          if (done || aborted) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === 'data: [DONE]') {
              // The protocol is complete even if the HTTP connection stays open.
              void reader.cancel().catch((err) => {
                logDebug('askCode.minimax', 'reader.cancel rejected', { err: String(err) });
              });
              break readStream;
            }
            if (!trimmed) continue;
            if (!trimmed.startsWith('data:')) continue;
            try {
              const json = JSON.parse(trimmed.slice(5).trim()) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) {
                const text = visibleMinimaxContent(delta, thinkingFilter);
                if (text) send({ type: 'chunk', text });
              }
            } catch {
              // ignore parse errors in SSE stream
            }
          }
        }
        if (!thinkingFilter.insideThinking && thinkingFilter.pending) {
          send({ type: 'chunk', text: thinkingFilter.pending });
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
