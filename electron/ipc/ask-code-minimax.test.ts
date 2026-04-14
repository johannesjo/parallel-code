import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  askAboutCodeMinimax,
  cancelAskAboutCodeMinimax,
  MINIMAX_MODEL,
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

  it('uses MiniMax-M2.7 model', async () => {
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
    expect(body.model).toBe(MINIMAX_MODEL);
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
