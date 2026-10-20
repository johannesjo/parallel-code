// HTTP access control + validation for the phone's merge routes:
//   GET  /api/mobile/tasks/:taskId/readiness — read-only, like diff/notes
//   POST /api/mobile/tasks/:taskId/merge     — runs real git, so paired only
//
// The view-only QR token may read readiness but must never be able to merge.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import http from 'node:http';
import type { RemoteMergeReadiness } from './protocol.js';

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
let getMergeReadiness: Mock<(taskId: string) => Promise<RemoteMergeReadiness>>;
let mergeTaskFromMobile: Mock<NonNullable<StartOpts['mergeTaskFromMobile']>>;

const READY: RemoteMergeReadiness = {
  readiness: {
    overall: 'ready',
    checks: [{ label: 'Merge safety', status: 'pass', detail: 'Branch is mergeable.' }],
  },
  canMerge: true,
  baseBranch: 'main',
  branchName: 'task/thing',
};

async function start(extra: Partial<StartOpts> = {}): Promise<void> {
  const srv = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: '/nonexistent',
    getTaskName: (id) => id,
    getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
    getCoordinator: () => null,
    getMergeReadiness,
    mergeTaskFromMobile,
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
  getMergeReadiness = vi.fn(async (_taskId: string) => READY);
  mergeTaskFromMobile = vi.fn(async (_req) => {});
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

const READY_PATH = '/api/mobile/tasks/task-1/readiness';
const MERGE_PATH = '/api/mobile/tasks/task-1/merge';

describe('GET /api/mobile/tasks/:taskId/readiness', () => {
  beforeEach(() => start());

  it('returns 401 without a token', async () => {
    expect((await request('GET', READY_PATH)).status).toBe(401);
    expect(getMergeReadiness).not.toHaveBeenCalled();
  });

  it('returns 403 for coordinator and subtask tokens', async () => {
    for (const token of [coordinatorToken, subtaskToken]) {
      expect((await request('GET', READY_PATH, { token })).status).toBe(403);
    }
    expect(getMergeReadiness).not.toHaveBeenCalled();
  });

  // Read-only, so the view-only token may read it — same as diff and notes.
  it('returns readiness for the view-only and paired tokens', async () => {
    for (const token of [mobileToken, await pair()]) {
      const res = await request('GET', READY_PATH, { token });
      expect(res.status).toBe(200);
      expect(res.json).toEqual(READY);
    }
    expect(getMergeReadiness).toHaveBeenCalledWith('task-1');
  });

  it('rejects a malformed escape and prototype keys', async () => {
    for (const id of ['%', '__proto__', 'constructor', 'prototype']) {
      const res = await request('GET', `/api/mobile/tasks/${id}/readiness`, { token: mobileToken });
      expect(res.status).toBe(400);
    }
    expect(getMergeReadiness).not.toHaveBeenCalled();
  });

  it('returns 405 for writes', async () => {
    expect((await request('POST', READY_PATH, { token: await pair(), body: {} })).status).toBe(405);
  });

  it('returns 503 when the renderer bridge is unavailable', async () => {
    await stop();
    await start({ getMergeReadiness: undefined });
    expect((await request('GET', READY_PATH, { token: mobileToken })).status).toBe(503);
  });

  it('passes a blocked verdict through with canMerge false', async () => {
    getMergeReadiness.mockResolvedValueOnce({
      readiness: {
        overall: 'blocked',
        checks: [
          { label: 'Merge safety', status: 'blocked', detail: 'Worktree has a detached HEAD.' },
        ],
      },
      canMerge: false,
      baseBranch: 'main',
      branchName: 'task/thing',
    });
    const res = await request('GET', READY_PATH, { token: mobileToken });
    expect(res.status).toBe(200);
    expect((res.json as { canMerge: boolean }).canMerge).toBe(false);
  });

  it('maps a renderer failure to 500', async () => {
    getMergeReadiness.mockRejectedValueOnce(new Error('git exploded'));
    const res = await request('GET', READY_PATH, { token: mobileToken });
    expect(res.status).toBe(500);
    expect((res.json as { error: string }).error).toContain('git exploded');
  });
});

describe('POST /api/mobile/tasks/:taskId/merge', () => {
  beforeEach(() => start());

  it('returns 401 without a token', async () => {
    expect((await request('POST', MERGE_PATH, { body: {} })).status).toBe(401);
    expect(mergeTaskFromMobile).not.toHaveBeenCalled();
  });

  // Merging runs real git, so the view-only token must be refused.
  it('returns 403 for the view-only token', async () => {
    expect((await request('POST', MERGE_PATH, { token: mobileToken, body: {} })).status).toBe(403);
    expect(mergeTaskFromMobile).not.toHaveBeenCalled();
  });

  it('returns 403 for coordinator and subtask tokens', async () => {
    for (const token of [coordinatorToken, subtaskToken]) {
      expect((await request('POST', MERGE_PATH, { token, body: {} })).status).toBe(403);
    }
    expect(mergeTaskFromMobile).not.toHaveBeenCalled();
  });

  it('merges for a paired token and defaults both flags to false', async () => {
    const res = await request('POST', MERGE_PATH, { token: await pair(), body: {} });
    expect(res.status).toBe(200);
    expect(mergeTaskFromMobile).toHaveBeenCalledWith({
      taskId: 'task-1',
      squash: false,
      cleanup: false,
    });
  });

  it('forwards explicit squash and cleanup', async () => {
    const res = await request('POST', MERGE_PATH, {
      token: await pair(),
      body: { squash: true, cleanup: true },
    });
    expect(res.status).toBe(200);
    expect(mergeTaskFromMobile).toHaveBeenCalledWith({
      taskId: 'task-1',
      squash: true,
      cleanup: true,
    });
  });

  // Never coerce a truthy value into permission to merge.
  it('rejects non-boolean flags rather than coercing them', async () => {
    const token = await pair();
    expect((await request('POST', MERGE_PATH, { token, body: { squash: 'yes' } })).status).toBe(
      400,
    );
    expect((await request('POST', MERGE_PATH, { token, body: { cleanup: 1 } })).status).toBe(400);
    expect(mergeTaskFromMobile).not.toHaveBeenCalled();
  });

  it('rejects a malformed escape and prototype keys', async () => {
    const token = await pair();
    for (const id of ['%', '__proto__', 'constructor', 'prototype']) {
      const res = await request('POST', `/api/mobile/tasks/${id}/merge`, { token, body: {} });
      expect(res.status).toBe(400);
    }
    expect(mergeTaskFromMobile).not.toHaveBeenCalled();
  });

  it('returns 405 for reads', async () => {
    expect((await request('GET', MERGE_PATH, { token: await pair() })).status).toBe(405);
    expect(mergeTaskFromMobile).not.toHaveBeenCalled();
  });

  it('returns 503 when the renderer bridge is unavailable', async () => {
    await stop();
    await start({ mergeTaskFromMobile: undefined });
    expect((await request('POST', MERGE_PATH, { token: await pair(), body: {} })).status).toBe(503);
  });

  it('maps a merge failure to 500 with the reason', async () => {
    mergeTaskFromMobile.mockRejectedValueOnce(new Error('Only worktree tasks can be merged'));
    const res = await request('POST', MERGE_PATH, { token: await pair(), body: {} });
    expect(res.status).toBe(500);
    expect((res.json as { error: string }).error).toContain('Only worktree tasks');
  });
});
