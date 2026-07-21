// HTTP access control + validation for the mobile task-notes route
// (GET/PUT /api/mobile/notes/:taskId). These guard security-relevant
// regressions: a malformed percent-escape once crashed the main process, and
// a prototype-chain taskId could pollute Object.prototype via the store.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import http from 'node:http';

vi.mock('../ipc/pty.js', () => ({
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(),
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => []),
  getAgentMeta: vi.fn(() => null),
  getAgentCols: vi.fn(() => 80),
  onPtyEvent: vi.fn(() => vi.fn()),
}));

const { startRemoteServer } = await import('./server.js');

type StartOpts = Parameters<typeof startRemoteServer>[0];

let port = 0;
let mobileToken = '';
let coordinatorToken = '';
let subtaskToken = '';
let stop: () => Promise<void>;
let getTaskNotes: Mock<(taskId: string) => Promise<string>>;
let setTaskNotes: Mock<(taskId: string, notes: string) => Promise<void>>;

async function start(extra: Partial<StartOpts> = {}): Promise<void> {
  const srv = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: '/nonexistent',
    getTaskName: (id) => id,
    getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
    getCoordinator: () => null,
    getTaskNotes,
    setTaskNotes,
    ...extra,
  });
  port = srv.port;
  mobileToken = srv.mobileToken;
  coordinatorToken = srv.token;
  subtaskToken = srv.subtaskToken;
  stop = srv.stop;
}

beforeEach(() => {
  getTaskNotes = vi.fn(async (_taskId: string) => 'stored notes');
  setTaskNotes = vi.fn(async (_taskId: string, _notes: string) => {});
});

afterEach(async () => {
  await stop();
});

interface Res {
  status: number;
  json: unknown;
}

/** Raw HTTP request so the exact (possibly malformed) path reaches the server. */
function request(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    let payload: string | undefined;
    if (opts.body !== undefined) {
      payload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json: unknown = undefined;
        try {
          json = data ? JSON.parse(data) : undefined;
        } catch {
          json = data;
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('GET /api/mobile/notes/:taskId', () => {
  beforeEach(() => start());

  it('returns 401 without a token', async () => {
    const res = await request('GET', '/api/mobile/notes/task-1');
    expect(res.status).toBe(401);
    expect(getTaskNotes).not.toHaveBeenCalled();
  });

  it('returns 403 for a coordinator token', async () => {
    const res = await request('GET', '/api/mobile/notes/task-1', { token: coordinatorToken });
    expect(res.status).toBe(403);
    expect(getTaskNotes).not.toHaveBeenCalled();
  });

  it('returns 403 for a subtask token', async () => {
    const res = await request('GET', '/api/mobile/notes/task-1', { token: subtaskToken });
    expect(res.status).toBe(403);
    expect(getTaskNotes).not.toHaveBeenCalled();
  });

  it('returns the notes for a mobile token', async () => {
    const res = await request('GET', '/api/mobile/notes/task-1', { token: mobileToken });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ notes: 'stored notes' });
    expect(getTaskNotes).toHaveBeenCalledWith('task-1');
  });

  it('decodes a percent-encoded task id', async () => {
    const res = await request('GET', '/api/mobile/notes/task%2F1', { token: mobileToken });
    expect(res.status).toBe(200);
    expect(getTaskNotes).toHaveBeenCalledWith('task/1');
  });
});

describe('GET/PUT notes — malformed and dangerous task ids', () => {
  beforeEach(() => start());

  it('returns 400 (not a crash) on a malformed percent-escape', async () => {
    const res = await request('GET', '/api/mobile/notes/%', { token: mobileToken });
    expect(res.status).toBe(400);
    expect(getTaskNotes).not.toHaveBeenCalled();
    // The server is still alive after the malformed request.
    const ok = await request('GET', '/api/mobile/notes/task-1', { token: mobileToken });
    expect(ok.status).toBe(200);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects the prototype-chain task id %s with 400',
    async (key) => {
      const res = await request('PUT', `/api/mobile/notes/${key}`, {
        token: mobileToken,
        body: { notes: 'pwned' },
      });
      expect(res.status).toBe(400);
      expect(setTaskNotes).not.toHaveBeenCalled();
    },
  );
});

describe('PUT /api/mobile/notes/:taskId', () => {
  beforeEach(() => start());

  it('saves notes for a mobile token', async () => {
    const res = await request('PUT', '/api/mobile/notes/task-1', {
      token: mobileToken,
      body: { notes: 'hello world' },
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(setTaskNotes).toHaveBeenCalledWith('task-1', 'hello world');
  });

  it('returns 403 for a coordinator token', async () => {
    const res = await request('PUT', '/api/mobile/notes/task-1', {
      token: coordinatorToken,
      body: { notes: 'x' },
    });
    expect(res.status).toBe(403);
    expect(setTaskNotes).not.toHaveBeenCalled();
  });

  it('rejects a non-string notes body with 400', async () => {
    const res = await request('PUT', '/api/mobile/notes/task-1', {
      token: mobileToken,
      body: { notes: 123 },
    });
    expect(res.status).toBe(400);
    expect(setTaskNotes).not.toHaveBeenCalled();
  });

  it('rejects notes larger than 100 KB with 400', async () => {
    const res = await request('PUT', '/api/mobile/notes/task-1', {
      token: mobileToken,
      body: { notes: 'x'.repeat(100 * 1024 + 1) },
    });
    expect(res.status).toBe(400);
    expect(setTaskNotes).not.toHaveBeenCalled();
  });

  it('accepts multi-line notes up to the limit', async () => {
    const notes = 'line\n'.repeat(1000);
    const res = await request('PUT', '/api/mobile/notes/task-1', {
      token: mobileToken,
      body: { notes },
    });
    expect(res.status).toBe(200);
    expect(setTaskNotes).toHaveBeenCalledWith('task-1', notes);
  });
});

describe('notes route without a renderer bridge', () => {
  beforeEach(() => start({ getTaskNotes: undefined, setTaskNotes: undefined }));

  it('returns 503 for GET when notes are unavailable', async () => {
    const res = await request('GET', '/api/mobile/notes/task-1', { token: mobileToken });
    expect(res.status).toBe(503);
  });

  it('returns 503 for PUT when notes are unavailable', async () => {
    const res = await request('PUT', '/api/mobile/notes/task-1', {
      token: mobileToken,
      body: { notes: 'x' },
    });
    expect(res.status).toBe(503);
  });
});
