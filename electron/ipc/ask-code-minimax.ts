import type { BrowserWindow } from 'electron';

interface MinimaxAskCodeRequest {
  requestId: string;
  channelId: string;
  prompt: string;
}

const MAX_PROMPT_LENGTH = 50_000;
const MAX_CONCURRENT = 5;
const TIMEOUT_MS = 120_000;
const MINIMAX_API_URL = 'https://api.minimax.io/v1/chat/completions';
export const MINIMAX_MODEL = 'MiniMax-M2.7';

const activeRequests = new Map<string, AbortController>();
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Main-process storage for the MiniMax API key. Never sent back to the renderer. */
let storedApiKey = '';

export function setMinimaxApiKey(key: string): void {
  storedApiKey = key.trim();
}

export function getMinimaxApiKey(): string {
  return storedApiKey;
}

export function askAboutCodeMinimax(win: BrowserWindow, args: MinimaxAskCodeRequest): void {
  const { requestId, channelId, prompt } = args;
  const apiKey = storedApiKey;

  if (!apiKey) {
    throw new Error('MiniMax API key is not set. Please configure it in Settings.');
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Prompt too long (${prompt.length} chars, max ${MAX_PROMPT_LENGTH})`);
  }
  if (activeRequests.size >= MAX_CONCURRENT) {
    throw new Error('Too many concurrent ask-about-code requests');
  }

  cancelAskAboutCodeMinimax(requestId);

  const controller = new AbortController();
  activeRequests.set(requestId, controller);

  const send = (msg: unknown) => {
    if (!win.isDestroyed()) {
      win.webContents.send(`channel:${channelId}`, msg);
    }
  };

  let finished = false;

  function cleanup() {
    activeRequests.delete(requestId);
    const timer = activeTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      activeTimers.delete(requestId);
    }
  }

  // Safety timeout: kill after 2 minutes
  const timer = setTimeout(() => {
    activeTimers.delete(requestId);
    if (activeRequests.has(requestId)) {
      finished = true;
      send({ type: 'error', text: 'Request timed out after 2 minutes.' });
      cancelAskAboutCodeMinimax(requestId);
      send({ type: 'done', exitCode: 1 });
    }
  }, TIMEOUT_MS);
  activeTimers.set(requestId, timer);

  fetch(MINIMAX_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MINIMAX_MODEL,
      messages: [
        {
          role: 'system',
          content: 'Answer concisely about the selected code. Use markdown.',
        },
        { role: 'user', content: prompt },
      ],
      // MiniMax temperature must be in (0.0, 1.0]
      temperature: 0.3,
      max_tokens: 2048,
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

      // When the AbortController fires, cancel the reader so reader.read() resolves
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        reader.cancel().catch(() => {});
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

      cleanup();
      if (!finished) {
        finished = true;
        send({ type: 'done', exitCode: 0, cancelled: aborted });
      }
    })
    .catch((err: unknown) => {
      cleanup();
      if (!finished) {
        finished = true;
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
  const controller = activeRequests.get(requestId);
  if (controller) {
    controller.abort();
    activeRequests.delete(requestId);
  }
  const timer = activeTimers.get(requestId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(requestId);
  }
}

export function isMinimaxRequestActive(requestId: string): boolean {
  return activeRequests.has(requestId);
}
