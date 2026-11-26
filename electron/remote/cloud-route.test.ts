// HTTP access control + validation for the phone's cloud handoff route:
//   GET  /api/mobile/tasks/:taskId/cloud — whether the task can continue in the cloud
//   POST /api/mobile/tasks/:taskId/cloud — optionally pushes, then starts the session
//
// Both are paired only: starting pushes the branch and launches a program on the desktop.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import http from 'node:http';

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
const AVAILABLE = {
  available: true as const,
  prompt: 'Continue this task: Fix login',
  branchName: 'task/fix-login',
  canPush: true,
};
let getCloudHandoff: Mock<NonNullable<StartOpts['getCloudHandoff']>>;
let startCloudHandoff: Mock<NonNullable<StartOpts['startCloudHandoff']>>;

async function start(extra: Partial<StartOpts> = {}): Promise<void> {
  const srv = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: '/nonexistent',
    getTaskName: (id) => id,
    getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
    getCoordinator: () => null,
    getCloudHandoff,
    startCloudHandoff,
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
  getCloudHandoff = vi.fn(async (_taskId: string) => AVAILABLE);
  startCloudHandoff = vi.fn(async (_req: { taskId: string; prompt: string; push: boolean }) => {});
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

const PATH = '/api/mobile/tasks/task-1/cloud';
const BODY = { prompt: 'Keep going', push: true };

describe('/api/mobile/tasks/:taskId/cloud', () => {
  beforeEach(() => start());

  it('returns 401 without a token', async () => {
    expect((await request('GET', PATH)).status).toBe(401);
    expect((await request('POST', PATH, { body: BODY })).status).toBe(401);
  });

  it('returns 403 for view-only, coordinator and subtask tokens', async () => {
    for (const token of [mobileToken, coordinatorToken, subtaskToken]) {
      expect((await request('GET', PATH, { token })).status).toBe(403);
      expect((await request('POST', PATH, { token, body: BODY })).status).toBe(403);
    }
    expect(getCloudHandoff).not.toHaveBeenCalled();
    expect(startCloudHandoff).not.toHaveBeenCalled();
  });

  it('tells a paired phone whether the task can continue in the cloud', async () => {
    const token = await pair();
    expect(await request('GET', PATH, { token })).toEqual({ status: 200, json: AVAILABLE });
    expect(getCloudHandoff).toHaveBeenCalledWith('task-1');
  });

  it('starts the handoff for a paired phone', async () => {
    const token = await pair();
    const res = await request('POST', PATH, { token, body: { prompt: 'Keep going', push: false } });
    expect(res).toEqual({ status: 200, json: { ok: true } });
    expect(startCloudHandoff).toHaveBeenCalledWith({
      taskId: 'task-1',
      prompt: 'Keep going',
      push: false,
    });
  });

  it('rejects a missing, blank or oversized prompt, and a missing push choice', async () => {
    const token = await pair();
    for (const body of [
      { push: true },
      { prompt: '  ', push: true },
      { prompt: 'x'.repeat(8_001), push: true },
      { prompt: 'Keep going' },
      { prompt: 'Keep going', push: 'yes' },
    ]) {
      expect((await request('POST', PATH, { token, body })).status).toBe(400);
    }
    expect(startCloudHandoff).not.toHaveBeenCalled();
  });

  it('reports desktop failures as 500', async () => {
    const token = await pair();
    getCloudHandoff.mockRejectedValueOnce(new Error('renderer gone'));
    expect((await request('GET', PATH, { token })).status).toBe(500);
    startCloudHandoff.mockRejectedValueOnce(new Error('push rejected'));
    const res = await request('POST', PATH, { token, body: BODY });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.json)).toContain('push rejected');
  });

  it('rejects other methods and prototype-key task ids', async () => {
    const token = await pair();
    expect((await request('PUT', PATH, { token })).status).toBe(405);
    expect((await request('GET', '/api/mobile/tasks/__proto__/cloud', { token })).status).toBe(400);
  });
});

describe('/api/mobile/tasks/:taskId/cloud without desktop support', () => {
  beforeEach(() => start({ getCloudHandoff: undefined, startCloudHandoff: undefined }));

  it('returns 503', async () => {
    expect((await request('GET', PATH, { token: await pair() })).status).toBe(503);
  });
});
