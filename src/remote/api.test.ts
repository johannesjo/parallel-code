import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, closeTask } from './api';

const PAIRED_TOKEN_KEY = 'parallel-code-paired-token';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const storage = new Map<string, string>([[PAIRED_TOKEN_KEY, 'paired-token']]);
  const store = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('sessionStorage', store);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('closeTask', () => {
  it('returns the warnings the desktop lists when it refuses with 409', async () => {
    const warnings = ['2 uncommitted files', '3 commits not merged into main'];
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'closing would lose work', warnings }));

    await expect(closeTask('task-1')).resolves.toEqual({ warnings });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/mobile/tasks/task-1/close');
    expect(JSON.parse(String(init.body))).toEqual({ force: false });
  });

  it('falls back to the error message when a 409 lists no warnings', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'closing would lose work' }));

    await expect(closeTask('task-1')).resolves.toEqual({
      warnings: ['closing would lose work'],
    });
  });

  it('returns no warnings once the task is closed', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

    await expect(closeTask('task-1', true)).resolves.toEqual({ warnings: [] });
  });

  it('rethrows other failures', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'boom' }));

    await expect(closeTask('task-1')).rejects.toBeInstanceOf(ApiError);
  });
});
