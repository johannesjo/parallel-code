// HTTP access control + validation for the phone's Fix CI route:
//   GET  /api/mobile/tasks/:taskId/fix-ci — the failed-checks prompt to review
//   POST /api/mobile/tasks/:taskId/fix-ci — sends the reviewed prompt to the agent
//
// Both are paired only: the prompt exists to be sent, which the view-only token cannot.

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
let getFixCiPrompt: Mock<NonNullable<StartOpts['getFixCiPrompt']>>;
let sendFixCiPrompt: Mock<NonNullable<StartOpts['sendFixCiPrompt']>>;

async function start(extra: Partial<StartOpts> = {}): Promise<void> {
  const srv = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: '/nonexistent',
    getTaskName: (id) => id,
    getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
    getCoordinator: () => null,
    getFixCiPrompt,
    sendFixCiPrompt,
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
  getFixCiPrompt = vi.fn(async (_taskId: string) => 'CI failed on pull request #7.');
  sendFixCiPrompt = vi.fn(async (_taskId: string, _prompt: string) => {});
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

const PATH = '/api/mobile/tasks/task-1/fix-ci';

describe('/api/mobile/tasks/:taskId/fix-ci', () => {
  beforeEach(() => start());

  it('returns 401 without a token', async () => {
    expect((await request('GET', PATH)).status).toBe(401);
    expect((await request('POST', PATH, { body: { prompt: 'x' } })).status).toBe(401);
  });

  it('returns 403 for view-only, coordinator and subtask tokens', async () => {
    for (const token of [mobileToken, coordinatorToken, subtaskToken]) {
      expect((await request('GET', PATH, { token })).status).toBe(403);
      expect((await request('POST', PATH, { token, body: { prompt: 'x' } })).status).toBe(403);
    }
    expect(getFixCiPrompt).not.toHaveBeenCalled();
    expect(sendFixCiPrompt).not.toHaveBeenCalled();
  });

  it('returns the prompt, or null when nothing failed, to a paired phone', async () => {
    const token = await pair();
    let res = await request('GET', PATH, { token });
    expect(res).toEqual({ status: 200, json: { prompt: 'CI failed on pull request #7.' } });
    expect(getFixCiPrompt).toHaveBeenCalledWith('task-1');

    getFixCiPrompt.mockResolvedValueOnce(null);
    res = await request('GET', PATH, { token });
    expect(res).toEqual({ status: 200, json: { prompt: null } });
  });

  it('sends the reviewed prompt for a paired phone', async () => {
    const token = await pair();
    const res = await request('POST', PATH, { token, body: { prompt: 'Fix the lint job.' } });
    expect(res).toEqual({ status: 200, json: { ok: true } });
    expect(sendFixCiPrompt).toHaveBeenCalledWith('task-1', 'Fix the lint job.');
  });

  it('rejects a missing, blank or oversized prompt', async () => {
    const token = await pair();
    for (const body of [{}, { prompt: '  ' }, { prompt: 7 }, { prompt: 'x'.repeat(60_001) }]) {
      expect((await request('POST', PATH, { token, body })).status).toBe(400);
    }
    expect(sendFixCiPrompt).not.toHaveBeenCalled();
  });

  it('reports desktop failures as 500', async () => {
    const token = await pair();
    getFixCiPrompt.mockRejectedValueOnce(new Error('gh failed'));
    expect((await request('GET', PATH, { token })).status).toBe(500);
    sendFixCiPrompt.mockRejectedValueOnce(new Error('agent gone'));
    expect((await request('POST', PATH, { token, body: { prompt: 'x' } })).status).toBe(500);
  });

  it('rejects other methods and prototype-key task ids', async () => {
    const token = await pair();
    expect((await request('PUT', PATH, { token })).status).toBe(405);
    expect((await request('GET', '/api/mobile/tasks/__proto__/fix-ci', { token })).status).toBe(
      400,
    );
  });
});

describe('/api/mobile/tasks/:taskId/fix-ci without desktop support', () => {
  beforeEach(() => start({ getFixCiPrompt: undefined, sendFixCiPrompt: undefined }));

  it('returns 503', async () => {
    expect((await request('GET', PATH, { token: await pair() })).status).toBe(503);
  });
});
