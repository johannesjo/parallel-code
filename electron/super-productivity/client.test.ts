import { describe, expect, it, vi } from 'vitest';
import { createSpClient } from './client.js';

type Handler = (method: string, path: string, body: unknown) => { status: number; json: unknown };

function fakeFetch(handler: Handler) {
  return vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const { status, json } = handler(init.method ?? 'GET', url.pathname, body);
    return new Response(JSON.stringify(json), { status });
  });
}

const ok = (data: unknown) => ({ status: 200, json: { ok: true, data } });

describe('createSpClient', () => {
  it('reports not_configured without a token and never calls out', async () => {
    const fetchImpl = fakeFetch(() => ok(null));
    const client = createSpClient({ getToken: () => null, fetchImpl });
    expect(await client.getConnectionState()).toBe('not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the bearer token and no Origin header', async () => {
    const fetchImpl = fakeFetch(() => ok({ currentTaskId: null }));
    const client = createSpClient({ getToken: () => 'tok', fetchImpl });
    expect(await client.getConnectionState()).toBe('connected');
    const init = fetchImpl.mock.calls[0][1];
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('maps API failures to connection states', async () => {
    const cases: [number, string, string][] = [
      [401, 'UNAUTHORIZED', 'unauthorized'],
      [503, 'API_DISABLED', 'disabled'],
      [503, 'APP_NOT_READY', 'not_ready'],
    ];
    for (const [status, code, expected] of cases) {
      const client = createSpClient({
        getToken: () => 'tok',
        fetchImpl: fakeFetch(() => ({
          status,
          json: { ok: false, error: { code, message: 'x' } },
        })),
      });
      expect(await client.getConnectionState()).toBe(expected);
    }
    const down = createSpClient({
      getToken: () => 'tok',
      fetchImpl: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    });
    expect(await down.getConnectionState()).toBe('unreachable');
  });

  it('narrows task payloads from the other app', async () => {
    const client = createSpClient({
      getToken: () => 'tok',
      fetchImpl: fakeFetch(() =>
        ok({
          id: 't1',
          title: 'Fix',
          notes: 'n',
          isDone: false,
          projectId: 'p1',
          parentId: null,
          issueUrl: 'javascript:alert(1)',
          extra: 'ignored',
        }),
      ),
    });
    expect(await client.getTask('t1')).toEqual({
      ok: true,
      value: { id: 't1', title: 'Fix', notes: 'n', isDone: false, projectId: 'p1', parentId: null },
    });
  });

  it('keeps an http(s) issue link', async () => {
    const client = createSpClient({
      getToken: () => 'tok',
      fetchImpl: fakeFetch(() =>
        ok({ id: 't1', title: 'Fix', issueUrl: 'https://github.com/o/r/issues/1' }),
      ),
    });
    const res = await client.getTask('t1');
    expect(res.ok && res.value.issueUrl).toBe('https://github.com/o/r/issues/1');
  });

  it('reads tracking state including a running break', async () => {
    const client = createSpClient({
      getToken: () => 'tok',
      fetchImpl: fakeFetch((_m, path) =>
        path === '/focus'
          ? ok({ timer: { purpose: 'break', status: 'running' } })
          : ok({ id: 't1', title: 'Fix', parentId: 'parent' }),
      ),
    });
    expect(await client.getTracking()).toEqual({
      ok: true,
      value: {
        current: { id: 't1', title: 'Fix', isDone: false, projectId: null, parentId: 'parent' },
        isBreak: true,
      },
    });
  });

  it('asks for literal titles on create and rename', async () => {
    const fetchImpl = fakeFetch((_m, _p, body) => ({
      status: 201,
      json: { ok: true, data: { id: 'n', ...(body as object) } },
    }));
    const client = createSpClient({ getToken: () => 'tok', fetchImpl });
    await client.createTask({ title: 'Fix #12 in 30m', projectId: 'p1' });
    await client.renameTask('n', 'Rename #x');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string)).toEqual({
      title: 'Fix #12 in 30m',
      projectId: 'p1',
      isIgnoreShortSyntax: true,
    });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body as string)).toEqual({
      title: 'Rename #x',
      isIgnoreShortSyntax: true,
    });
  });

  it('only asks for the issue link when needed', async () => {
    const fetchImpl = fakeFetch(() => ok({ id: 't1', title: 'Fix' }));
    const client = createSpClient({ getToken: () => 'tok', fetchImpl });
    await client.getTask('t1');
    await client.getTask('t1', { includeIssueUrl: true });
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      'http://127.0.0.1:3876/tasks/t1',
      'http://127.0.0.1:3876/tasks/t1?include=issueUrl',
    ]);
  });

  it('rejects task payloads with malformed ids', async () => {
    const client = createSpClient({
      getToken: () => 'tok',
      fetchImpl: fakeFetch(() => ok({ id: '../x', title: 'Fix' })),
    });
    expect(await client.getTask('t1')).toMatchObject({ ok: false, reason: 'error' });
  });

  it('creates subtasks under their parent without a projectId', async () => {
    const fetchImpl = fakeFetch((_m, _p, body) => ({
      status: 201,
      json: { ok: true, data: { id: 'n', ...(body as object) } },
    }));
    const client = createSpClient({ getToken: () => 'tok', fetchImpl });
    await client.createTask({ title: 'Sub', projectId: 'p1', parentId: 'parent' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string)).toEqual({
      title: 'Sub',
      parentId: 'parent',
      isIgnoreShortSyntax: true,
    });
  });

  it('completes a task by appending to its notes', async () => {
    const fetchImpl = fakeFetch((method) =>
      method === 'GET' ? ok({ id: 't1', title: 'Fix', notes: 'Old' }) : ok({}),
    );
    const client = createSpClient({ getToken: () => 'tok', fetchImpl });
    expect(await client.completeTask('t1', 'Merged.')).toEqual({ ok: true, value: null });
    const patch = fetchImpl.mock.calls[1][1];
    expect(patch.method).toBe('PATCH');
    expect(JSON.parse(patch.body as string)).toEqual({ isDone: true, notes: 'Old\n\nMerged.' });
  });

  it('skips missing tasks in a batch but reports a dead connection', async () => {
    const client = createSpClient({
      getToken: () => 'tok',
      fetchImpl: fakeFetch((_m, path) =>
        path === '/tasks/gone'
          ? { status: 404, json: { ok: false, error: { code: 'TASK_NOT_FOUND', message: '' } } }
          : ok({ id: path.split('/').pop(), title: 'T' }),
      ),
    });
    const res = await client.getTasks(['a', 'gone', 'b', 'a']);
    expect(res.ok && res.value.map((t) => t.id).sort()).toEqual(['a', 'b']);

    const down = createSpClient({
      getToken: () => 'tok',
      fetchImpl: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    });
    expect(await down.getTasks(['a'])).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('treats only a missing entity as gone, not an unknown route', async () => {
    const respond = (code: string) =>
      createSpClient({
        getToken: () => 'tok',
        fetchImpl: fakeFetch(() => ({
          status: 404,
          json: { ok: false, error: { code, message: '' } },
        })),
      });
    expect(await respond('TASK_NOT_FOUND').getTask('t1')).toMatchObject({ reason: 'not_found' });
    expect(await respond('NOT_FOUND').getTask('t1')).toMatchObject({ reason: 'error' });
    const html = createSpClient({
      getToken: () => 'tok',
      fetchImpl: vi.fn(async () => new Response('<html>nope</html>', { status: 404 })),
    });
    expect(await html.getTask('t1')).toMatchObject({ reason: 'error' });
  });

  it('keeps going past a task that fails to load, and returns summaries only', async () => {
    const client = createSpClient({
      getToken: () => 'tok',
      fetchImpl: fakeFetch((_m, path) =>
        path === '/tasks/bad'
          ? { status: 500, json: { ok: false, error: { code: 'INTERNAL_ERROR', message: '' } } }
          : ok({ id: path.split('/').pop(), title: 'T', notes: 'private' }),
      ),
    });
    const res = await client.getTasks(['a', 'bad', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(res.ok && res.value.map((t) => t.id).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
    ]);
    expect(res.ok && res.value.every((t) => !('notes' in t))).toBe(true);
  });

  it('times out a response body that never finishes', async () => {
    const client = createSpClient({
      getToken: () => 'tok',
      readTimeoutMs: 20,
      fetchImpl: vi.fn(async (_input: string, init: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ok":'));
            init.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError')),
            );
          },
        });
        return new Response(body, { status: 200 });
      }),
    });
    expect(await client.getTask('t1')).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('refuses to read an unreadable current task as "nothing tracked"', async () => {
    const client = createSpClient({
      getToken: () => 'tok',
      fetchImpl: fakeFetch((_m, path) =>
        path === '/focus' ? ok({ timer: null }) : ok({ id: '../x', title: 'Weird' }),
      ),
    });
    expect(await client.getTracking()).toMatchObject({ ok: false, reason: 'error' });
  });
});
