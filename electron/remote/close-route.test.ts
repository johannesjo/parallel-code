// HTTP access control + validation for the mobile task-close route
// (POST /api/mobile/tasks/:taskId/close). Closing removes a worktree, so only
// the paired token may call it, and without force the desktop's warnings
// come back as a 409 instead of a close.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import http from 'node:http';
import type { RemoteCloseResult } from './protocol.js';

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
let closeTaskFromMobile: Mock<(taskId: string, force: boolean) => Promise<RemoteCloseResult>>;

async function start(extra: Partial<StartOpts> = {}): Promise<void> {
  const srv = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: '/nonexistent',
    getTaskName: (id) => id,
    getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
    getCoordinator: () => null,
    closeTaskFromMobile,
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
  closeTaskFromMobile = vi.fn(
    async (_taskId: string, force: boolean): Promise<RemoteCloseResult> =>
      force ? { closed: true } : { closed: false, warnings: ['uncommitted changes'] },
  );
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

const PATH = '/api/mobile/tasks/task-1/close';

describe('POST /api/mobile/tasks/:taskId/close', () => {
  beforeEach(() => start());

  it('returns 401 without a token', async () => {
    const res = await request('POST', PATH, { body: {} });
    expect(res.status).toBe(401);
    expect(closeTaskFromMobile).not.toHaveBeenCalled();
  });

  it('returns 403 for the view-only mobile token', async () => {
    const res = await request('POST', PATH, { token: mobileToken, body: { force: true } });
    expect(res.status).toBe(403);
    expect(closeTaskFromMobile).not.toHaveBeenCalled();
  });

  it('returns 403 for coordinator and subtask tokens', async () => {
    for (const token of [coordinatorToken, subtaskToken]) {
      const res = await request('POST', PATH, { token, body: { force: true } });
      expect(res.status).toBe(403);
    }
    expect(closeTaskFromMobile).not.toHaveBeenCalled();
  });

  it('returns 409 with the warnings when closing would lose work', async () => {
    const token = await pair();
    const res = await request('POST', PATH, { token, body: {} });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({
      error: 'closing would lose work',
      warnings: ['uncommitted changes'],
    });
    expect(closeTaskFromMobile).toHaveBeenCalledWith('task-1', false);
  });

  it('closes with force for a paired token', async () => {
    const token = await pair();
    const res = await request('POST', PATH, { token, body: { force: true } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(closeTaskFromMobile).toHaveBeenCalledWith('task-1', true);
  });

  it('rejects a non-boolean force', async () => {
    const token = await pair();
    const res = await request('POST', PATH, { token, body: { force: 'yes' } });
    expect(res.status).toBe(400);
    expect(closeTaskFromMobile).not.toHaveBeenCalled();
  });

  it('rejects a malformed escape and prototype keys', async () => {
    const token = await pair();
    for (const id of ['%', '__proto__', 'constructor']) {
      const res = await request('POST', `/api/mobile/tasks/${id}/close`, { token, body: {} });
      expect(res.status).toBe(400);
    }
    expect(closeTaskFromMobile).not.toHaveBeenCalled();
  });

  it('returns 405 for other methods', async () => {
    const token = await pair();
    const res = await request('GET', PATH, { token });
    expect(res.status).toBe(405);
  });

  it('returns 503 when the desktop cannot close tasks', async () => {
    await stop();
    await start({ closeTaskFromMobile: undefined });
    const token = await pair();
    const res = await request('POST', PATH, { token, body: { force: true } });
    expect(res.status).toBe(503);
  });
});
