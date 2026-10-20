import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageResult } from './shared-types.js';
import { parseResetsAt, requestUsage } from './usage-shared.js';

describe('parseResetsAt', () => {
  it('treats small numbers as epoch seconds and large ones as milliseconds', () => {
    expect(parseResetsAt(1_738_425_600)).toBe(1_738_425_600_000);
    expect(parseResetsAt(1_738_425_600_000)).toBe(1_738_425_600_000);
  });

  it('parses ISO strings and rejects junk', () => {
    expect(parseResetsAt('2025-02-01T16:00:00Z')).toBe(Date.parse('2025-02-01T16:00:00Z'));
    expect(parseResetsAt('soon')).toBeNull();
    expect(parseResetsAt(undefined)).toBeNull();
    expect(parseResetsAt(Number.NaN)).toBeNull();
  });
});

describe('requestUsage', () => {
  const OK: UsageResult = { status: 'ok', fiveHour: null, sevenDay: null, fetchedAt: 1 };
  const request = {
    scope: 'test-usage',
    agent: 'Test CLI',
    url: 'https://example.test/usage',
    headers: { Authorization: 'Bearer tok' },
    parse: () => OK,
  };

  function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the headers as given and hands the body to the parser', async () => {
    const fetchMock = stubFetch(200, { hello: 1 });
    const parse = vi.fn(() => OK);
    await expect(requestUsage({ ...request, parse })).resolves.toBe(OK);
    expect(parse).toHaveBeenCalledWith({ hello: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(request.url);
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('is unavailable when the parser finds no windows', async () => {
    stubFetch(200, {});
    const result = await requestUsage({ ...request, parse: () => null });
    expect(result.status).toBe('unavailable');
  });

  it('reports rejected tokens as a recoverable error naming the agent', async () => {
    stubFetch(403, { error: 'expired' });
    const result = await requestUsage(request);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toMatch(/Test CLI login token rejected \(HTTP 403\)/);
    }
  });

  it('reports other HTTP failures with their status', async () => {
    stubFetch(429, {});
    await expect(requestUsage(request)).resolves.toEqual({
      status: 'error',
      message: 'Usage endpoint returned HTTP 429',
    });
  });

  it('reports network failures without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    await expect(requestUsage(request)).resolves.toEqual({
      status: 'error',
      message: 'ECONNRESET',
    });
  });
});
