// HTTP access control + validation for the mobile task-diff route
// (GET /api/mobile/tasks/:taskId/diff): readable by the view-only and paired
// phone tokens, like notes, and by nothing else.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import http from 'node:http';
import type { RemoteTaskDiff } from './protocol.js';

vi.mock('../ipc/pty.js', () => ({
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(),
  subscribeToAgentRendered: vi.fn(() => null),
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => []),
  getAgentMeta: vi.fn(() => null),
  getAgentCols: vi.fn(() => 80),
  getAgentRows: vi.fn(() => 24),
  onPtyEvent: vi.fn(() => vi.fn()),
}));

const { startRemoteServer } = await import('./server.js');

type StartOpts = Parameters<typeof startRemoteServer>[0];

let port = 0;
let mobileToken = '';
let coordinatorToken = '';
let subtaskToken = '';
let generatePin: () => { pin: string; expiresAt: number };
let stop: () => Promise<void>;
let getTaskDiff: Mock<(taskId: string) => Promise<RemoteTaskDiff>>;

async function start(extra: Partial<StartOpts> = {}): Promise<void> {
  const srv = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: '/nonexistent',
    getTaskName: (id) => id,
    getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
    getCoordinator: () => null,
    getTaskDiff,
    ...extra,
  });
  port = srv.port;
  mobileToken = srv.mobileToken;
  coordinatorToken = srv.token;
  subtaskToken = srv.subtaskToken;
  generatePin = srv.generatePairingPin;
  stop = srv.stop;
}

/** Elevate the mobile token to a paired one via the desktop PIN. */
async function pair(): Promise<string> {
  const { pin } = generatePin();
  const res = await request('POST', '/api/pair/verify', { token: mobileToken, body: { pin } });
  expect(res.status).toBe(201);
  return (res.json as { token: string }).token;
}

beforeEach(() => {
  getTaskDiff = vi.fn(async (_taskId: string) => ({
    diff: 'diff --git a/x b/x',
    truncated: false,
  }));
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

const PATH = '/api/mobile/tasks/task-1/diff';

describe('GET /api/mobile/tasks/:taskId/diff', () => {
  beforeEach(() => start());

  it('returns 401 without a token', async () => {
    expect((await request('GET', PATH)).status).toBe(401);
    expect(getTaskDiff).not.toHaveBeenCalled();
  });

  it('returns 403 for coordinator and subtask tokens', async () => {
    for (const token of [coordinatorToken, subtaskToken]) {
      expect((await request('GET', PATH, { token })).status).toBe(403);
    }
    expect(getTaskDiff).not.toHaveBeenCalled();
  });

  it('returns the diff for the view-only and paired tokens', async () => {
    for (const token of [mobileToken, await pair()]) {
      const res = await request('GET', PATH, { token });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ diff: 'diff --git a/x b/x', truncated: false });
    }
    expect(getTaskDiff).toHaveBeenCalledWith('task-1');
  });

  it('passes the unsupported flag through for a task with no branch', async () => {
    // A 'none' task edits the project folder in place, so the desktop answers
    // with an empty diff and this flag rather than an error.
    getTaskDiff.mockResolvedValueOnce({ diff: '', truncated: false, unsupported: true });
    const res = await request('GET', PATH, { token: mobileToken });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ diff: '', truncated: false, unsupported: true });
  });

  it('rejects a malformed escape and prototype keys', async () => {
    for (const id of ['%', '__proto__']) {
      const res = await request('GET', `/api/mobile/tasks/${id}/diff`, { token: mobileToken });
      expect(res.status).toBe(400);
    }
    expect(getTaskDiff).not.toHaveBeenCalled();
  });

  it('returns 405 for writes', async () => {
    expect((await request('POST', PATH, { token: await pair(), body: {} })).status).toBe(405);
  });
});
