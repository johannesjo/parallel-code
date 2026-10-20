import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CHANGE_TOUR_PROMPT_LIMIT } from '../shared/change-tour-limits.js';
import {
  UNDERSTANDING_MAX_OUTPUT_CHARS,
  UNDERSTANDING_PROMPT_LIMIT,
} from '../shared/understanding-limits.js';

/** Purposes that ask MiniMax for one JSON object, with their own budget and prompt. */
const STRUCTURED_PURPOSES = [
  {
    purpose: 'tour',
    promptLimit: CHANGE_TOUR_PROMPT_LIMIT,
    systemPrompt:
      'Return exactly one JSON object matching the requested tour schema. No markdown, commentary, or additional JSON objects.',
  },
  {
    purpose: 'understand',
    promptLimit: UNDERSTANDING_PROMPT_LIMIT,
    systemPrompt:
      'Return exactly one JSON object matching the requested understanding tour schema. No markdown, commentary, or additional JSON objects.',
  },
] as const;

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  askAboutCodeMinimax,
  cancelAskAboutCodeMinimax,
  setMinimaxApiKey,
} from './ask-code-minimax.js';

function makeMockWin() {
  const messages: unknown[] = [];
  const win = {
    isDestroyed: vi.fn().mockReturnValue(false),
    webContents: {
      send: vi.fn().mockImplementation((_ch: string, msg: unknown) => {
        messages.push(msg);
      }),
    },
  } as unknown as import('electron').BrowserWindow;
  return { win, messages };
}

/** Wait until a 'done' message appears in the messages array. */
function waitForDone(messages: unknown[], timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function check() {
      if (messages.some((m) => (m as Record<string, unknown>).type === 'done')) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('Timed out waiting for done message'));
        return;
      }
      setTimeout(check, 10);
    }
    check();
  });
}

function makeStreamResponse(sseText: string): Response {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(sseText);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function sseChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

describe('askAboutCodeMinimax', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMinimaxApiKey('test-key');
  });

  it('throws if prompt exceeds max length', () => {
    const { win } = makeMockWin();
    const longPrompt = 'x'.repeat(50_001);
    expect(() =>
      askAboutCodeMinimax(win, {
        requestId: 'r1',
        channelId: 'ch1',
        prompt: longPrompt,
      }),
    ).toThrow(/Prompt too long/);
  });

  it.each(STRUCTURED_PURPOSES)(
    'accepts a full $purpose prompt without raising the inline Q&A limit',
    async ({ purpose, promptLimit, systemPrompt }) => {
      const { win, messages } = makeMockWin();
      const prompt = 'x'.repeat(promptLimit);
      mockFetch.mockResolvedValueOnce(makeStreamResponse('data: [DONE]\n\n'));
      askAboutCodeMinimax(win, {
        requestId: `large-${purpose}`,
        channelId: 'test',
        prompt,
        purpose,
      });
      await waitForDone(messages);
      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as {
        messages: { content: string }[];
        max_tokens: number;
      };
      expect(body.messages[1].content).toBe(prompt);
      expect(body.messages[0].content).toBe(systemPrompt);
      // Derived from the card caps, so raising a cap cannot silently truncate a
      // tour the validator would have accepted.
      expect(body.max_tokens).toBe(Math.ceil(UNDERSTANDING_MAX_OUTPUT_CHARS / 3));
    },
  );

  it.each(STRUCTURED_PURPOSES)(
    'rejects a $purpose larger than its dedicated allowance before fetching',
    ({ purpose, promptLimit }) => {
      const { win } = makeMockWin();
      expect(() =>
        askAboutCodeMinimax(win, {
          requestId: `too-large-${purpose}`,
          channelId: 'test',
          prompt: 'x'.repeat(promptLimit + 1),
          purpose,
        }),
      ).toThrow(/Prompt too long/);
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it('allows room for Flash thinking and the inline answer', async () => {
    const { win, messages } = makeMockWin();
    mockFetch.mockResolvedValueOnce(makeStreamResponse('data: [DONE]\n\n'));
    askAboutCodeMinimax(win, { requestId: 'inline', channelId: 'test', prompt: 'Explain' });
    await waitForDone(messages);
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as {
      max_tokens: number;
    };
    expect(body.max_tokens).toBe(16_384);
  });

  it('sends chunk messages for each SSE delta', async () => {
    const { win, messages } = makeMockWin();

    const sseText = sseChunk('Hello') + sseChunk(', world') + 'data: [DONE]\n\n';
    mockFetch.mockResolvedValueOnce(makeStreamResponse(sseText));

    askAboutCodeMinimax(win, {
      requestId: 'r2',
      channelId: 'ch2',
      prompt: 'Explain this code',
    });

    await waitForDone(messages);

    const chunkMsgs = messages.filter((m) => (m as Record<string, unknown>).type === 'chunk');
    expect(chunkMsgs).toHaveLength(2);
    expect((chunkMsgs[0] as Record<string, unknown>).text).toBe('Hello');
    expect((chunkMsgs[1] as Record<string, unknown>).text).toBe(', world');

    const doneMsgs = messages.filter((m) => (m as Record<string, unknown>).type === 'done');
    expect(doneMsgs).toHaveLength(1);
    expect((doneMsgs[0] as Record<string, unknown>).exitCode).toBe(0);
  });

  it.each(['MiniMax-M3', 'MiniMax-M2.7', 'custom/model-v1'])(
    'preserves the explicit %s model at the HTTP boundary',
    async (model) => {
      const { win, messages } = makeMockWin();
      mockFetch.mockResolvedValueOnce(makeStreamResponse('data: [DONE]\n\n'));
      askAboutCodeMinimax(win, {
        requestId: 'saved',
        channelId: 'saved',
        prompt: 'Explain',
        model,
      });
      await waitForDone(messages);
      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.model).toBe(model);
      expect(body.max_tokens).toBe(2048);
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('service_tier');
      if (model === 'MiniMax-M3') {
        expect(body.thinking).toEqual({ type: 'disabled' });
        expect(body.reasoning_split).toBe(true);
      } else {
        expect(body).not.toHaveProperty('thinking');
        expect(body).not.toHaveProperty('reasoning_split');
      }
    },
  );

  it('does not forward separated thinking into a structured answer', async () => {
    const { win, messages } = makeMockWin();
    mockFetch.mockResolvedValueOnce(
      makeStreamResponse(
        'data: {"choices":[{"delta":{"reasoning_content":"<think>private reasoning</think>"}}]}\n\n' +
          sseChunk('{"cards":[]}') +
          'data: [DONE]\n\n',
      ),
    );
    askAboutCodeMinimax(win, {
      requestId: 'reasoning',
      channelId: 'reasoning',
      prompt: 'Tour',
      purpose: 'tour',
    });
    await waitForDone(messages);
    expect(messages.filter((message) => (message as { type: string }).type === 'chunk')).toEqual([
      { type: 'chunk', text: '{"cards":[]}' },
    ]);
  });

  it('sends error message on non-ok HTTP response', async () => {
    const { win, messages } = makeMockWin();

    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    askAboutCodeMinimax(win, {
      requestId: 'r3',
      channelId: 'ch3',
      prompt: 'What is this?',
    });

    await waitForDone(messages);

    const errMsgs = messages.filter((m) => (m as Record<string, unknown>).type === 'error');
    expect(errMsgs.length).toBeGreaterThan(0);
    expect((errMsgs[0] as Record<string, unknown>).text).toMatch(/401/);

    const doneMsgs = messages.filter((m) => (m as Record<string, unknown>).type === 'done');
    expect((doneMsgs[0] as Record<string, unknown>).exitCode).toBe(1);
  });

  it('finishes on the SSE done marker even when the connection remains open', async () => {
    const { win, messages } = makeMockWin();
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(sseChunk('Complete answer') + 'data: [DONE]\n\n'),
        );
      },
      cancel,
    });
    mockFetch.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    askAboutCodeMinimax(win, { requestId: 'done-open', channelId: 'done-open', prompt: 'Explain' });
    try {
      await waitForDone(messages, 200);
      expect(messages).toContainEqual({ type: 'done', exitCode: 0, cancelled: false });
      expect(cancel).toHaveBeenCalled();
    } finally {
      cancelAskAboutCodeMinimax('done-open');
    }
  });

  it('sends error message when fetch rejects', async () => {
    const { win, messages } = makeMockWin();

    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    askAboutCodeMinimax(win, {
      requestId: 'r4',
      channelId: 'ch4',
      prompt: 'Explain',
    });

    await waitForDone(messages);

    const errMsgs = messages.filter((m) => (m as Record<string, unknown>).type === 'error');
    expect(errMsgs.length).toBeGreaterThan(0);
    expect((errMsgs[0] as Record<string, unknown>).text).toMatch(/Network failure/);
  });

  it('sends correct Authorization header with Bearer token', async () => {
    const { win, messages } = makeMockWin();

    mockFetch.mockResolvedValueOnce(makeStreamResponse('data: [DONE]\n\n'));

    setMinimaxApiKey('my-secret-key');
    askAboutCodeMinimax(win, {
      requestId: 'r5',
      channelId: 'ch5',
      prompt: 'Explain',
    });

    await waitForDone(messages);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('minimax.io'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer my-secret-key',
        }),
      }),
    );
  });

  it('defaults to Flash at the HTTP boundary', async () => {
    const { win, messages } = makeMockWin();

    mockFetch.mockResolvedValueOnce(makeStreamResponse('data: [DONE]\n\n'));

    askAboutCodeMinimax(win, {
      requestId: 'r6',
      channelId: 'ch6',
      prompt: 'Test',
    });

    await waitForDone(messages);

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as {
      model: string;
    };
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.minimax.io/v1/chat/completions');
    expect(body).toMatchObject({
      model: 'MiniMax-M3.1-Flash',
      thinking: { type: 'adaptive' },
      reasoning_effort: 'low',
      reasoning_split: true,
    });
    expect(body).not.toHaveProperty('service_tier');
  });

  it('uses temperature in MiniMax allowed range (0, 1]', async () => {
    const { win, messages } = makeMockWin();

    mockFetch.mockResolvedValueOnce(makeStreamResponse('data: [DONE]\n\n'));

    askAboutCodeMinimax(win, {
      requestId: 'r7',
      channelId: 'ch7',
      prompt: 'Test',
    });

    await waitForDone(messages);

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as {
      temperature: number;
    };
    expect(body.temperature).toBeGreaterThan(0);
    expect(body.temperature).toBeLessThanOrEqual(1);
  });

  it('uses streaming mode', async () => {
    const { win, messages } = makeMockWin();

    mockFetch.mockResolvedValueOnce(makeStreamResponse('data: [DONE]\n\n'));

    askAboutCodeMinimax(win, {
      requestId: 'r8',
      channelId: 'ch8',
      prompt: 'Test',
    });

    await waitForDone(messages);

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as {
      stream: boolean;
    };
    expect(body.stream).toBe(true);
  });

  it('does not send to destroyed window', async () => {
    const { win, messages } = makeMockWin();
    (win.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);

    mockFetch.mockResolvedValueOnce(makeStreamResponse(sseChunk('Hello') + 'data: [DONE]\n\n'));

    askAboutCodeMinimax(win, {
      requestId: 'r9',
      channelId: 'ch9',
      prompt: 'Test',
    });

    // Small delay to let the async chain run
    await new Promise((r) => setTimeout(r, 100));
    expect(messages).toHaveLength(0);
  });

  it('includes a system prompt instructing concise markdown answers', async () => {
    const { win, messages } = makeMockWin();

    mockFetch.mockResolvedValueOnce(makeStreamResponse('data: [DONE]\n\n'));

    askAboutCodeMinimax(win, {
      requestId: 'r10',
      channelId: 'ch10',
      prompt: 'Explain this',
    });

    await waitForDone(messages);

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = body.messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.content).toMatch(/markdown/i);
  });
});

describe('cancelAskAboutCodeMinimax', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMinimaxApiKey('test-key');
  });

  it('cancels a pending request without sending an error message', async () => {
    const { win, messages } = makeMockWin();

    // Simulate a slow response that never closes
    const neverEnding = new ReadableStream({
      start(controller) {
        // Enqueue one empty byte so the response is ok
        controller.enqueue(new Uint8Array(0));
        // never close — reader.read() will block
      },
    });
    mockFetch.mockResolvedValueOnce(new Response(neverEnding, { status: 200 }));

    askAboutCodeMinimax(win, {
      requestId: 'cancel-1',
      channelId: 'ch-cancel',
      prompt: 'Test',
    });

    // Give fetch time to start
    await new Promise((r) => setTimeout(r, 20));

    cancelAskAboutCodeMinimax('cancel-1');

    // Wait for done message (AbortError -> done sent without error)
    await waitForDone(messages);

    const errMsgs = messages.filter((m) => (m as Record<string, unknown>).type === 'error');
    // AbortError should NOT produce an error message
    expect(errMsgs).toHaveLength(0);
  });

  it('is a no-op for unknown requestId', () => {
    expect(() => cancelAskAboutCodeMinimax('unknown-id')).not.toThrow();
  });
});
