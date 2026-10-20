import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPClient } from './client.js';

function stubFetch(...responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const r of responses)
    fetchMock.mockImplementationOnce(() =>
      r instanceof Error ? Promise.reject(r) : Promise.resolve(r),
    );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MCPClient transport', () => {
  const client = new MCPClient('http://x', 'tok');

  it('accepts an empty 2xx body', async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(client.closeTask('t')).resolves.toBeUndefined();
  });

  it('truncates large error bodies', async () => {
    stubFetch(new Response('x'.repeat(50_000), { status: 502 }));
    const err = await client.getTaskStatus('t').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.length).toBeLessThan(2300);
    expect((err as Error).message).toContain('truncated');
  });

  it('bounds waits with a client-side abort signal', async () => {
    const fetchMock = stubFetch(Response.json({ status: 'idle', reason: 'x' }));
    await client.waitForIdle('t', 1000);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports the real cause when retries consume the whole wait budget', async () => {
    vi.useFakeTimers();
    stubFetch(new TypeError('fetch failed'), new TypeError('fetch failed'));
    const pending = client.waitForSignalDone('c', 1000).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const err = await pending;
    expect((err as Error).message).toContain('1000ms timeout elapsed: fetch failed');
  });
});
