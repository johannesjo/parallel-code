// Integration tests for coordinator-scoped task access in the remote HTTP server.
// Verifies that a coordinator can only see and control its own sub-tasks.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { Coordinator } from '../mcp/coordinator.js';
import type { ApiTaskSummary, ApiTaskDetail } from '../mcp/types.js';
import type { CompletionRecord, CompletionReport } from '../shared/completion-report.js';

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
  onPtyEvent: vi.fn(() => vi.fn()), // returns an unsubscribe fn
}));

vi.mock('./protocol.js', () => ({
  parseClientMessage: vi.fn(() => null),
}));

const { startRemoteServer } = await import('./server.js');

// --- Minimal task fixtures ---

const COORD_A = 'coordinator-a';
const COORD_B = 'coordinator-b';
const completion: CompletionRecord = {
  id: 'completion-1',
  completedAt: '2026-09-26T12:00:00.000Z',
  reviewRevision: 1,
  sourceCommit: 'a'.repeat(40),
  snapshotState: 'clean',
};
const completionReport: CompletionReport = {
  summary: 'Finished the assigned change.',
  verification: { checks: [{ name: 'tests', command: 'npm test', result: 'passed' }] },
  artifacts: [{ path: 'src/main.ts', label: 'Updated module' }],
  unresolvedIssues: ['Native smoke test unavailable.'],
};

const taskA: ApiTaskDetail = {
  id: 'task-a-1',
  name: 'Task A',
  branchName: 'task/task-a',
  worktreePath: '/tmp/task-a',
  projectId: 'proj-1',
  agentId: 'agent-a',
  status: 'idle',
  coordinatorTaskId: COORD_A,
  exitCode: null,
};

const taskB: ApiTaskDetail = {
  id: 'task-b-1',
  name: 'Task B',
  branchName: 'task/task-b',
  worktreePath: '/tmp/task-b',
  projectId: 'proj-1',
  agentId: 'agent-b',
  status: 'idle',
  coordinatorTaskId: COORD_B,
  exitCode: null,
};

const summaryA: ApiTaskSummary = {
  id: taskA.id,
  name: taskA.name,
  branchName: taskA.branchName,
  status: taskA.status,
  coordinatorTaskId: taskA.coordinatorTaskId,
};

const summaryB: ApiTaskSummary = {
  id: taskB.id,
  name: taskB.name,
  branchName: taskB.branchName,
  status: taskB.status,
  coordinatorTaskId: taskB.coordinatorTaskId,
};

// Per-task done tokens, keyed by taskId
const DONE_TOKENS: Record<string, string> = {
  [taskA.id]: 'done-token-a',
  [taskB.id]: 'done-token-b',
};

function makeMockCoordinator(): Coordinator {
  const tasks = new Map<string, ApiTaskDetail>([
    [taskA.id, taskA],
    [taskB.id, taskB],
  ]);

  return {
    isRegisteredCoordinator: (id: string) => id === COORD_A || id === COORD_B,
    listTasks: () => [summaryA, summaryB],
    getTaskStatus: (id: string) => tasks.get(id) ?? null,
    getTaskDoneToken: (id: string) => DONE_TOKENS[id] ?? null,
    sendPrompt: vi.fn().mockResolvedValue({ queued: false }),
    waitForIdle: vi.fn().mockResolvedValue({ reason: 'idle' }),
    getTaskDiff: vi.fn().mockResolvedValue({ files: [], diff: '' }),
    getTaskOutput: vi.fn().mockReturnValue('output'),
    mergeTask: vi.fn().mockResolvedValue({ mainBranch: 'main', linesAdded: 0, linesRemoved: 0 }),
    closeTask: vi.fn().mockResolvedValue(undefined),
    landSelf: vi.fn().mockResolvedValue({
      mainBranch: 'main',
      linesAdded: 1,
      linesRemoved: 0,
      landingState: 'reviewed',
      landedMetadata: {
        taskId: taskA.id,
        taskName: taskA.name,
        coordinatorTaskId: COORD_A,
        targetBranch: 'main',
        landedCommit: 'abc123',
        landedAt: new Date().toISOString(),
        landedOrder: 1,
        verification: { checks: [{ name: 'test', command: 'npm test', result: 'passed' }] },
      },
    }),
    reviewAndMergeTask: vi.fn().mockResolvedValue({
      diff: { files: [], diff: '' },
      merge: { mainBranch: 'main', linesAdded: 0, linesRemoved: 0 },
    }),
    createTask: vi.fn().mockResolvedValue(taskA),
    signalDone: vi.fn().mockResolvedValue({ ok: true, completion }),
    waitForSignalDone: vi.fn().mockResolvedValue({
      taskId: taskA.id,
      name: taskA.name,
      status: 'idle',
      signalDoneAt: new Date().toISOString(),
      remaining: 0,
    }),
  } as unknown as Coordinator;
}

// --- Test helpers ---

let serverToken = '';
let serverPort = 0;
let serverStop: () => Promise<void>;

async function startServer(coordinator: Coordinator, isOrchestrationEnabled = () => true) {
  const srv = await startRemoteServer({
    port: 0, // random port
    host: '0.0.0.0',
    staticDir: '/nonexistent',
    getTaskName: (id) => id,
    getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
    getCoordinator: () => coordinator,
    isOrchestrationEnabled,
  });
  serverToken = srv.token;
  serverPort = srv.port;
  serverStop = srv.stop;
  return srv;
}

function httpRequest(
  method: string,
  path: string,
  body?: unknown,
  coordinatorId?: string,
  rawBody?: string,
): Promise<{ status: number; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyStr = rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${serverToken}`,
      'Content-Type': 'application/json',
    };
    if (coordinatorId) headers['X-Coordinator-Id'] = coordinatorId;
    if (bodyStr) headers['Content-Length'] = String(Buffer.byteLength(bodyStr));

    const req = http.request(
      { hostname: '127.0.0.1', port: serverPort, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode ?? 0,
            json: () => Promise.resolve(JSON.parse(raw) as unknown),
          });
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const get = (path: string, coordinatorId?: string) =>
  httpRequest('GET', path, undefined, coordinatorId);
const post = (path: string, body: unknown, coordinatorId?: string) =>
  httpRequest('POST', path, body, coordinatorId);
const del = (path: string, coordinatorId?: string) =>
  httpRequest('DELETE', path, undefined, coordinatorId);

// --- Tests ---

describe('lazy coordinator lookup — server started before coordinator exists', () => {
  let stop: () => Promise<void>;
  let token = '';
  let port = 0;

  afterEach(async () => {
    await stop();
  });

  it('returns 503 when coordinator is null at request time, then works after coordinator is set', async () => {
    let coord: Coordinator | null = null;

    const srv = await startRemoteServer({
      port: 0,
      host: '0.0.0.0',
      staticDir: '/nonexistent',
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
      getCoordinator: () => coord,
    });
    token = srv.token;
    port = srv.port;
    stop = srv.stop;

    const req = (method: string, path: string, body?: unknown) =>
      new Promise<{ status: number; json: () => Promise<unknown> }>((resolve, reject) => {
        const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        };
        if (bodyStr) headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
        const r = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            resolve({ status: res.statusCode ?? 0, json: () => Promise.resolve(JSON.parse(raw)) });
          });
        });
        r.on('error', reject);
        if (bodyStr) r.write(bodyStr);
        r.end();
      });

    // Coordinator routes should return 503 when no coordinator is present
    const before = await req('GET', '/api/tasks');
    expect(before.status).toBe(503);
    expect(await before.json()).toMatchObject({ error: 'coordinator not available' });

    // POST /api/tasks should also return 503
    const beforePost = await req('POST', '/api/tasks', { name: 'test' });
    expect(beforePost.status).toBe(503);

    // Non-coordinator routes (agents list) should still work
    const agents = await req('GET', '/api/agents');
    expect(agents.status).toBe(200);

    // Set coordinator
    coord = makeMockCoordinator();

    // Now coordinator routes should work — coordinator token requires X-Coordinator-Id
    const reqWithHeader = (method: string, path: string, body?: unknown) =>
      new Promise<{ status: number; json: () => Promise<unknown> }>((resolve, reject) => {
        const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Coordinator-Id': COORD_A,
        };
        if (bodyStr) headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
        const r = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            resolve({ status: res.statusCode ?? 0, json: () => Promise.resolve(JSON.parse(raw)) });
          });
        });
        r.on('error', reject);
        if (bodyStr) r.write(bodyStr);
        r.end();
      });
    const after = await reqWithHeader('GET', '/api/tasks');
    expect(after.status).toBe(200);
  });
});

describe('coordinator scoping', () => {
  let mockCoord: Coordinator;

  beforeEach(async () => {
    mockCoord = makeMockCoordinator();
    await startServer(mockCoord);
  });

  afterEach(async () => {
    await serverStop();
  });

  describe('list_tasks', () => {
    it('returns 403 when no X-Coordinator-Id header (coordinator token requires scoping)', async () => {
      const res = await get('/api/tasks');
      expect(res.status).toBe(403);
    });

    it('returns only coordinator A tasks when X-Coordinator-Id is coordinator-a', async () => {
      const res = await get('/api/tasks', COORD_A);
      expect(res.status).toBe(200);
      const tasks = (await res.json()) as ApiTaskSummary[];
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(taskA.id);
    });

    it('returns only coordinator B tasks when X-Coordinator-Id is coordinator-b', async () => {
      const res = await get('/api/tasks', COORD_B);
      expect(res.status).toBe(200);
      const tasks = (await res.json()) as ApiTaskSummary[];
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(taskB.id);
    });
  });

  describe('get_task_status', () => {
    it('allows coordinator A to access its own task', async () => {
      const res = await get(`/api/tasks/${taskA.id}`, COORD_A);
      expect(res.status).toBe(200);
    });

    it('returns 403 when coordinator A accesses coordinator B task', async () => {
      const res = await get(`/api/tasks/${taskB.id}`, COORD_A);
      expect(res.status).toBe(403);
    });

    it('returns 403 for coordinator token without X-Coordinator-Id', async () => {
      const resA = await get(`/api/tasks/${taskA.id}`);
      expect(resA.status).toBe(403);
      const resB = await get(`/api/tasks/${taskB.id}`);
      expect(resB.status).toBe(403);
    });
  });

  describe('send_prompt', () => {
    it('allows coordinator A to send prompt to its own task', async () => {
      const res = await post(`/api/tasks/${taskA.id}/prompt`, { prompt: 'hello' }, COORD_A);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true, queued: false });
    });

    it('strips control characters before sending prompt to the task PTY', async () => {
      const res = await post(`/api/tasks/${taskA.id}/prompt`, { prompt: 'hi\x03\rthere' }, COORD_A);
      expect(res.status).toBe(200);
      expect(mockCoord.sendPrompt).toHaveBeenLastCalledWith(taskA.id, 'hi  there');
    });

    it('rejects missing prompts before sending them to the coordinator', async () => {
      const beforeCalls = vi.mocked(mockCoord.sendPrompt).mock.calls.length;

      const res = await post(`/api/tasks/${taskA.id}/prompt`, {}, COORD_A);

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'prompt must be a non-empty string' });
      expect(vi.mocked(mockCoord.sendPrompt).mock.calls).toHaveLength(beforeCalls);
    });

    it('rejects blank prompts before sending them to the coordinator', async () => {
      const beforeCalls = vi.mocked(mockCoord.sendPrompt).mock.calls.length;

      const res = await post(`/api/tasks/${taskA.id}/prompt`, { prompt: '  ' }, COORD_A);

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'prompt must be a non-empty string' });
      expect(vi.mocked(mockCoord.sendPrompt).mock.calls).toHaveLength(beforeCalls);
    });

    it('rejects non-string prompts before sending them to the coordinator', async () => {
      const beforeCalls = vi.mocked(mockCoord.sendPrompt).mock.calls.length;

      const res = await post(`/api/tasks/${taskA.id}/prompt`, { prompt: 123 }, COORD_A);

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'prompt must be a non-empty string' });
      expect(vi.mocked(mockCoord.sendPrompt).mock.calls).toHaveLength(beforeCalls);
    });

    it('rejects control-character-only prompts after sanitization', async () => {
      const beforeCalls = vi.mocked(mockCoord.sendPrompt).mock.calls.length;

      const res = await post(`/api/tasks/${taskA.id}/prompt`, { prompt: '\x03\r\n' }, COORD_A);

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'prompt must be a non-empty string' });
      expect(vi.mocked(mockCoord.sendPrompt).mock.calls).toHaveLength(beforeCalls);
    });

    it('returns 404 for send_prompt to a missing task before calling the coordinator send path', async () => {
      const beforeCalls = vi.mocked(mockCoord.sendPrompt).mock.calls.length;

      const res = await post('/api/tasks/missing-task/prompt', { prompt: 'hello' }, COORD_A);

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: 'task not found' });
      expect(vi.mocked(mockCoord.sendPrompt).mock.calls).toHaveLength(beforeCalls);
    });

    it('rejects oversized prompts before sending them to the coordinator', async () => {
      const res = await post(
        `/api/tasks/${taskA.id}/prompt`,
        { prompt: 'x'.repeat(16 * 1024 + 1) },
        COORD_A,
      );
      expect(res.status).toBe(400);
    });

    it('passes an in-limit Unicode prompt exactly to the coordinator', async () => {
      const prompt = `continue with ${'火'.repeat(100)} 😀`;

      const res = await post(`/api/tasks/${taskA.id}/prompt`, { prompt }, COORD_A);

      expect(res.status).toBe(200);
      expect(mockCoord.sendPrompt).toHaveBeenLastCalledWith(taskA.id, prompt);
    });

    it('rejects oversized multi-byte prompts before sending them to the coordinator', async () => {
      const beforeCalls = vi.mocked(mockCoord.sendPrompt).mock.calls.length;

      const res = await post(
        `/api/tasks/${taskA.id}/prompt`,
        { prompt: '😀'.repeat(5_000) },
        COORD_A,
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: 'prompt must be 16384 bytes or fewer',
      });
      expect(vi.mocked(mockCoord.sendPrompt).mock.calls).toHaveLength(beforeCalls);
    });

    it('returns queued status when the prompt is parked behind a hold', async () => {
      vi.mocked(mockCoord.sendPrompt).mockResolvedValueOnce({ queued: true });

      const res = await post(`/api/tasks/${taskA.id}/prompt`, { prompt: 'hello' }, COORD_A);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true, queued: true });
    });

    it('returns 500 when coordinator sendPrompt fails', async () => {
      vi.mocked(mockCoord.sendPrompt).mockRejectedValueOnce(new Error('Prompt queue full'));

      const res = await post(`/api/tasks/${taskA.id}/prompt`, { prompt: 'hello' }, COORD_A);

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: 'Error: Prompt queue full' });
    });

    it('returns 403 when coordinator A sends prompt to coordinator B task', async () => {
      const res = await post(`/api/tasks/${taskB.id}/prompt`, { prompt: 'hello' }, COORD_A);
      expect(res.status).toBe(403);
    });
  });

  describe('get_task_diff', () => {
    it('allows coordinator A to get diff of its own task', async () => {
      const res = await get(`/api/tasks/${taskA.id}/diff`, COORD_A);
      expect(res.status).toBe(200);
    });

    it('returns 403 when coordinator A gets diff of coordinator B task', async () => {
      const res = await get(`/api/tasks/${taskB.id}/diff`, COORD_A);
      expect(res.status).toBe(403);
    });
  });

  describe('get_task_output', () => {
    it('allows coordinator A to get output of its own task', async () => {
      const res = await get(`/api/tasks/${taskA.id}/output`, COORD_A);
      expect(res.status).toBe(200);
    });

    it('returns 403 when coordinator A gets output of coordinator B task', async () => {
      const res = await get(`/api/tasks/${taskB.id}/output`, COORD_A);
      expect(res.status).toBe(403);
    });
  });

  describe('merge_task', () => {
    it('allows coordinator A to merge its own task', async () => {
      const res = await post(`/api/tasks/${taskA.id}/merge`, {}, COORD_A);
      expect(res.status).toBe(200);
    });

    it('returns 403 when coordinator A merges coordinator B task', async () => {
      const res = await post(`/api/tasks/${taskB.id}/merge`, {}, COORD_A);
      expect(res.status).toBe(403);
    });
  });

  describe('close_task', () => {
    it('allows coordinator A to close its own task', async () => {
      const res = await del(`/api/tasks/${taskA.id}`, COORD_A);
      expect(res.status).toBe(200);
    });

    it('returns 403 when coordinator A closes coordinator B task', async () => {
      const res = await del(`/api/tasks/${taskB.id}`, COORD_A);
      expect(res.status).toBe(403);
    });
  });

  describe('review_and_merge_task', () => {
    it('allows coordinator A to review-merge its own task', async () => {
      const res = await post(`/api/tasks/${taskA.id}/review-merge`, {}, COORD_A);
      expect(res.status).toBe(200);
    });

    it('returns 403 when coordinator A review-merges coordinator B task', async () => {
      const res = await post(`/api/tasks/${taskB.id}/review-merge`, {}, COORD_A);
      expect(res.status).toBe(403);
    });
  });

  describe('create_task scoping', () => {
    it('uses X-Coordinator-Id as coordinatorTaskId when body omits it', async () => {
      const res = await post('/api/tasks', { name: 'new task', prompt: 'do the work' }, COORD_A);
      expect(res.status).toBe(201);
      // createTask should have been called with COORD_A as coordinatorTaskId
      const coord = mockCoord as unknown as ReturnType<typeof makeMockCoordinator>;
      const calls = (coord.createTask as ReturnType<typeof vi.fn>).mock.calls;
      const lastCall = calls[calls.length - 1][0] as { coordinatorTaskId: string };
      expect(lastCall.coordinatorTaskId).toBe(COORD_A);
    });

    it('returns 403 when body coordinatorTaskId differs from X-Coordinator-Id header', async () => {
      const res = await post(
        '/api/tasks',
        { name: 'new task', prompt: 'do the work', coordinatorTaskId: COORD_B },
        COORD_A,
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toMatchObject({ error: expect.stringContaining('coordinatorTaskId') });
    });

    it('accepts body coordinatorTaskId that matches X-Coordinator-Id header', async () => {
      const res = await post(
        '/api/tasks',
        { name: 'new task', prompt: 'do the work', coordinatorTaskId: COORD_A },
        COORD_A,
      );
      expect(res.status).toBe(201);
    });

    it('returns 400 when create_task omits the initial prompt', async () => {
      const res = await post('/api/tasks', { name: 'new task' }, COORD_A);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ error: 'prompt must be a non-empty string' });
    });

    it('returns 400 when create_task prompt is not a string', async () => {
      const beforeCalls = vi.mocked(mockCoord.createTask).mock.calls.length;

      const res = await post('/api/tasks', { name: 'new task', prompt: 123 }, COORD_A);

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'prompt must be a non-empty string' });
      expect(vi.mocked(mockCoord.createTask).mock.calls).toHaveLength(beforeCalls);
    });

    it('returns 400 when create_task prompt is empty after sanitization', async () => {
      const beforeCalls = vi.mocked(mockCoord.createTask).mock.calls.length;

      const res = await post('/api/tasks', { name: 'new task', prompt: '\x03\r\n' }, COORD_A);

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'prompt must be a non-empty string' });
      expect(vi.mocked(mockCoord.createTask).mock.calls).toHaveLength(beforeCalls);
    });

    it('strips control characters before using a create_task prompt', async () => {
      const res = await post('/api/tasks', { name: 'new task', prompt: 'do\x1b[200~it' }, COORD_A);
      expect(res.status).toBe(201);
      expect(mockCoord.createTask).toHaveBeenLastCalledWith(
        expect.objectContaining({ prompt: 'do [200~it' }),
      );
    });

    it('passes an in-limit Unicode create_task prompt exactly to the coordinator', async () => {
      const prompt = `summarize ${'火'.repeat(100)} 😀`;

      const res = await post('/api/tasks', { name: 'new task', prompt }, COORD_A);

      expect(res.status).toBe(201);
      expect(mockCoord.createTask).toHaveBeenLastCalledWith(expect.objectContaining({ prompt }));
    });

    it('rejects oversized multi-byte create_task prompts before calling the coordinator', async () => {
      const beforeCalls = vi.mocked(mockCoord.createTask).mock.calls.length;

      const res = await post(
        '/api/tasks',
        { name: 'new task', prompt: '😀'.repeat(5_000) },
        COORD_A,
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: 'prompt must be 16384 bytes or fewer',
      });
      expect(vi.mocked(mockCoord.createTask).mock.calls).toHaveLength(beforeCalls);
    });

    it('returns 500 when coordinator createTask fails', async () => {
      vi.mocked(mockCoord.createTask).mockRejectedValueOnce(
        new Error('coordinator coordinator-a is not registered'),
      );

      const res = await post('/api/tasks', { name: 'new task', prompt: 'do the work' }, COORD_A);

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({
        error: 'Error: coordinator coordinator-a is not registered',
      });
    });
  });

  describe('signal_done (coordinator token requires X-Coordinator-Id)', () => {
    it('returns 403 for signal_done with coordinator token but no X-Coordinator-Id', async () => {
      const res = await post(`/api/tasks/${taskA.id}/done`, {});
      expect(res.status).toBe(403);
    });

    it('allows signal_done when coordinator token includes valid X-Coordinator-Id', async () => {
      const res = await post(`/api/tasks/${taskA.id}/done`, {}, COORD_A);
      expect(res.status).toBe(200);
    });
  });
});

// ─── Subtask token access control ────────────────────────────────────────────

describe('coordinator agent token — bound to its own coordinator', () => {
  afterEach(async () => {
    await serverStop();
  });

  it('reaches only its own tasks and never the app-wide agent routes', async () => {
    const srv = await startServer(makeMockCoordinator());
    const agentToken = srv.coordinatorTokenFor(COORD_A);
    const call = (path: string, coordinatorId: string) =>
      fetch(`http://127.0.0.1:${serverPort}${path}`, {
        headers: { Authorization: `Bearer ${agentToken}`, 'X-Coordinator-Id': coordinatorId },
      });
    const own = await call('/api/tasks', COORD_A);
    expect(own.status).toBe(200);
    expect(((await own.json()) as ApiTaskSummary[]).map((task) => task.id)).toEqual([taskA.id]);
    expect((await call('/api/tasks', COORD_B)).status).toBe(401);
    expect((await call(`/api/tasks/${taskB.id}`, COORD_B)).status).toBe(401);
    expect((await call('/api/agents', COORD_A)).status).toBe(403);
    expect((await call('/api/agents/agent-b', COORD_A)).status).toBe(403);
  });
});

describe('subtask token — restricted to sub-task terminal tools', () => {
  let subtaskToken = '';
  let stop: () => Promise<void>;

  beforeEach(async () => {
    const coord = makeMockCoordinator();
    const srv = await startServer(coord);
    subtaskToken = srv.subtaskToken;
    stop = srv.stop;
  });

  afterEach(async () => {
    await stop();
  });

  function subtaskRequest(
    method: string,
    path: string,
    body?: unknown,
    doneTokenOverride?: string,
  ): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${subtaskToken}`,
        'Content-Type': 'application/json',
      };
      if (doneTokenOverride !== undefined) headers['X-Done-Token'] = doneTokenOverride;
      if (bodyStr) headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
      const req = http.request(
        { hostname: '127.0.0.1', port: serverPort, path, method, headers },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  it('subtaskToken is defined and differs from coordinator token', () => {
    expect(subtaskToken).toBeTruthy();
    expect(subtaskToken).not.toBe(serverToken);
  });

  it('POST /api/tasks/{id}/done is allowed with correct X-Done-Token header', async () => {
    const res = await subtaskRequest(
      'POST',
      `/api/tasks/${taskA.id}/done`,
      {},
      DONE_TOKENS[taskA.id],
    );
    expect(res.status).toBe(200);
  });

  it('POST /api/tasks/{id}/done returns 403 without X-Done-Token header', async () => {
    const res = await subtaskRequest('POST', `/api/tasks/${taskA.id}/done`, {});
    expect(res.status).toBe(403);
  });

  it('POST /api/tasks/{id}/done returns 403 when X-Done-Token is for wrong task', async () => {
    // taskB's done token used for taskA's done route
    const res = await subtaskRequest(
      'POST',
      `/api/tasks/${taskA.id}/done`,
      {},
      DONE_TOKENS[taskB.id],
    );
    expect(res.status).toBe(403);
  });

  it('POST /api/tasks/{id}/land is allowed with correct X-Done-Token header', async () => {
    const res = await subtaskRequest(
      'POST',
      `/api/tasks/${taskA.id}/land`,
      {
        verification: { checks: [{ name: 'test', command: 'npm test', result: 'passed' }] },
      },
      DONE_TOKENS[taskA.id],
    );
    expect(res.status).toBe(200);
  });

  it('POST /api/tasks/{id}/land returns 403 without X-Done-Token header', async () => {
    const res = await subtaskRequest('POST', `/api/tasks/${taskA.id}/land`, {
      verification: { checks: [{ name: 'test', command: 'npm test', result: 'passed' }] },
    });
    expect(res.status).toBe(403);
  });

  it('POST /api/tasks/{id}/land returns 403 when X-Done-Token is for wrong task', async () => {
    const res = await subtaskRequest(
      'POST',
      `/api/tasks/${taskA.id}/land`,
      {
        verification: { checks: [{ name: 'test', command: 'npm test', result: 'passed' }] },
      },
      DONE_TOKENS[taskB.id],
    );
    expect(res.status).toBe(403);
  });

  it('POST /api/tasks/{id}/land rejects missing verification', async () => {
    const res = await subtaskRequest(
      'POST',
      `/api/tasks/${taskA.id}/land`,
      {},
      DONE_TOKENS[taskA.id],
    );
    expect(res.status).toBe(400);
  });

  it.each([
    ['empty checks', { verification: { checks: [] } }],
    [
      'too many checks',
      {
        verification: {
          checks: Array.from({ length: 51 }, (_, i) => ({
            name: `check-${i}`,
            command: 'npm test',
            result: 'passed',
          })),
        },
      },
    ],
    [
      'empty check name',
      { verification: { checks: [{ name: '', command: 'npm test', result: 'passed' }] } },
    ],
    [
      'empty check command',
      { verification: { checks: [{ name: 'test', command: '', result: 'passed' }] } },
    ],
    [
      'invalid check result',
      { verification: { checks: [{ name: 'test', command: 'npm test', result: 'unknown' }] } },
    ],
    [
      'non-string summary',
      {
        verification: { checks: [{ name: 'test', command: 'npm test', result: 'passed' }] },
        summary: 123,
      },
    ],
    [
      'too-long summary',
      {
        verification: { checks: [{ name: 'test', command: 'npm test', result: 'passed' }] },
        summary: 'x'.repeat(20_001),
      },
    ],
  ])('POST /api/tasks/{id}/land rejects invalid body: %s', async (_label, body) => {
    const res = await subtaskRequest(
      'POST',
      `/api/tasks/${taskA.id}/land`,
      body,
      DONE_TOKENS[taskA.id],
    );
    expect(res.status).toBe(400);
  });

  it.each(['done', 'land'])(
    'POST /api/tasks/{id}/%s rejects a malformed task id escape with 400',
    async (route) => {
      const res = await subtaskRequest('POST', `/api/tasks/%/${route}`, {}, DONE_TOKENS[taskA.id]);
      expect(res.status).toBe(400);
    },
  );

  it('GET /api/tasks returns 403 with subtaskToken', async () => {
    const res = await subtaskRequest('GET', '/api/tasks');
    expect(res.status).toBe(403);
  });

  it('POST /api/tasks returns 403 with subtaskToken', async () => {
    const res = await subtaskRequest('POST', '/api/tasks', { name: 'x', prompt: 'y' });
    expect(res.status).toBe(403);
  });

  it('GET /api/agents returns 403 with subtaskToken', async () => {
    const res = await subtaskRequest('GET', '/api/agents');
    expect(res.status).toBe(403);
  });

  it('DELETE /api/tasks/{id} returns 403 with subtaskToken', async () => {
    const res = await subtaskRequest('DELETE', `/api/tasks/${taskA.id}`);
    expect(res.status).toBe(403);
  });

  it('POST /api/tasks/{id}/merge returns 403 with subtaskToken', async () => {
    const res = await subtaskRequest('POST', `/api/tasks/${taskA.id}/merge`);
    expect(res.status).toBe(403);
  });

  it('coordinator token with X-Coordinator-Id has full access to task routes', async () => {
    const res = await get('/api/tasks', COORD_A);
    expect(res.status).toBe(200);
  });
});

// ─── Mobile token access control ─────────────────────────────────────────────

describe('mobile token — restricted to agent routes only', () => {
  let mobileToken = '';
  let stop: () => Promise<void>;

  beforeEach(async () => {
    const coord = makeMockCoordinator();
    const srv = await startServer(coord);
    mobileToken = srv.mobileToken;
    stop = srv.stop;
  });

  afterEach(async () => {
    await stop();
  });

  function mobileRequest(method: string, path: string): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${mobileToken}`,
        'Content-Type': 'application/json',
      };
      const req = http.request(
        { hostname: '127.0.0.1', port: serverPort, path, method, headers },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('mobileToken is defined and differs from coordinator and subtask tokens', async () => {
    expect(mobileToken).toBeTruthy();
    expect(mobileToken).not.toBe(serverToken);
  });

  it('GET /api/agents is allowed', async () => {
    const res = await mobileRequest('GET', '/api/agents');
    expect(res.status).toBe(200);
  });

  it('GET /api/tasks returns 403 — coordinator task data must not be exposed via mobile token', async () => {
    const res = await mobileRequest('GET', '/api/tasks');
    expect(res.status).toBe(403);
  });

  it('GET /api/tasks/:id returns 403', async () => {
    const res = await mobileRequest('GET', `/api/tasks/${taskA.id}`);
    expect(res.status).toBe(403);
  });

  it('POST /api/wait-signal returns 403', async () => {
    const res = await mobileRequest('POST', '/api/wait-signal');
    expect(res.status).toBe(403);
  });

  it('POST /api/tasks returns 403', async () => {
    const res = await mobileRequest('POST', '/api/tasks');
    expect(res.status).toBe(403);
  });
});

describe('legacy HTTP completion handoffs', () => {
  let coord: Coordinator;
  let srv: Awaited<ReturnType<typeof startRemoteServer>>;
  beforeEach(async () => {
    coord = makeMockCoordinator();
    srv = await startServer(coord);
  });
  afterEach(async () => {
    await srv.stop();
  });

  const childDone = (taskId: string, body: unknown, doneToken: string) =>
    fetch(`http://127.0.0.1:${serverPort}/api/tasks/${taskId}/done`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${srv.subtaskToken}`,
        'Content-Type': 'application/json',
        'X-Done-Token': doneToken,
      },
      body: JSON.stringify(body),
    });

  it('returns the capture and parses structured reports for the owning task', async () => {
    vi.mocked(coord.signalDone).mockResolvedValueOnce({
      ok: true,
      completion: { ...completion, result: completionReport },
    });
    const response = await childDone(taskA.id, { result: completionReport }, DONE_TOKENS[taskA.id]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      completion: { ...completion, result: completionReport },
    });
    expect(coord.signalDone).toHaveBeenCalledExactlyOnceWith(
      taskA.id,
      { result: completionReport },
      expect.any(Function),
    );
  });

  it('keeps empty legacy calls valid and scopes coordinator reports to their children', async () => {
    const own = await post(`/api/tasks/${taskA.id}/done`, {}, COORD_A);
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ ok: true, completion });
    expect(
      (await post(`/api/tasks/${taskB.id}/done`, { result: completionReport }, COORD_A)).status,
    ).toBe(403);
    expect(
      (await childDone(taskA.id, { result: completionReport }, DONE_TOKENS[taskB.id])).status,
    ).toBe(403);
    expect(coord.signalDone).toHaveBeenCalledExactlyOnceWith(taskA.id, {}, expect.any(Function));
  });

  it.each([
    { result: { summary: '' } },
    { result: { summary: 'x', artifacts: [{ path: '../outside' }] } },
    { result: { summary: 'x', artifacts: [{ path: '/absolute' }] } },
    { result: { summary: 'x', verification: { checks: [] }, extra: true } },
    { result: { summary: 'x'.repeat(4097) } },
  ])('rejects malformed reports before capture: %j', async (body) => {
    const response = await post(`/api/tasks/${taskA.id}/done`, body, COORD_A);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error');
    expect(coord.signalDone).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON rather than treating it as an empty completion', async () => {
    const response = await httpRequest(
      'POST',
      `/api/tasks/${taskA.id}/done`,
      undefined,
      COORD_A,
      '{"result":',
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('Invalid JSON') });
    expect(coord.signalDone).not.toHaveBeenCalled();
  });

  it.each(['merge', 'review-merge'])('rejects malformed JSON on %s', async (action) => {
    const response = await httpRequest(
      'POST',
      `/api/tasks/${taskA.id}/${action}`,
      undefined,
      COORD_A,
      '{"squash":',
    );
    expect(response.status).toBe(400);
    expect(coord.mergeTask).not.toHaveBeenCalled();
  });

  it.each(['null', '[]', '42'])('rejects non-object JSON body %s on wait routes', async (body) => {
    for (const path of ['/api/wait-signal', `/api/tasks/${taskA.id}/wait`]) {
      const response = await httpRequest('POST', path, undefined, COORD_A, body);
      expect(response.status).toBe(400);
    }
    expect(coord.waitForSignalDone).not.toHaveBeenCalled();
    expect(coord.waitForIdle).not.toHaveBeenCalled();
  });

  it.each([0, -5, 'soon'])('rejects timeoutMs=%j on wait routes', async (timeoutMs) => {
    for (const path of ['/api/wait-signal', `/api/tasks/${taskA.id}/wait`]) {
      const response = await post(path, { timeoutMs }, COORD_A);
      expect(response.status).toBe(400);
    }
    expect(coord.waitForSignalDone).not.toHaveBeenCalled();
    expect(coord.waitForIdle).not.toHaveBeenCalled();
  });

  it('caps oversized timeoutMs on wait routes', async () => {
    const response = await post('/api/wait-signal', { timeoutMs: 1e15 }, COORD_A);
    expect(response.status).toBe(200);
    expect(coord.waitForSignalDone).toHaveBeenCalledWith(COORD_A, 2 ** 31 - 1, undefined);
  });

  it('rejects a coordinator agent token passed in the query string', async () => {
    const response = await new Promise<number>((resolve, reject) => {
      http
        .get(
          { hostname: '127.0.0.1', port: serverPort, path: `/api/tasks?token=${serverToken}` },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        )
        .on('error', reject);
    });
    expect(response).toBe(401);
  });

  it('denies publication if the done token changes during capture', async () => {
    const doneToken = vi.spyOn(coord, 'getTaskDoneToken');
    const publish = vi.fn();
    vi.mocked(coord.signalDone).mockImplementationOnce(async (_id, _input, assertCurrent) => {
      assertCurrent?.();
      await Promise.resolve();
      doneToken.mockReturnValue('replacement-token');
      assertCurrent?.();
      publish();
      return { ok: true, completion };
    });
    const response = await childDone(taskA.id, { result: completionReport }, DONE_TOKENS[taskA.id]);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('rechecks done ownership after reading a delayed request body', async () => {
    const doneToken = vi.spyOn(coord, 'getTaskDoneToken');
    const body = JSON.stringify({ result: completionReport });
    const pending = http.request({
      hostname: '127.0.0.1',
      port: srv.port,
      path: `/api/tasks/${taskA.id}/done`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${srv.subtaskToken}`,
        'X-Done-Token': DONE_TOKENS[taskA.id],
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Expect: '100-continue',
      },
    });
    const response = new Promise<number>((resolve, reject) => {
      pending.on('error', reject);
      pending.on('response', (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
    });
    const accepted = new Promise<void>((resolve) => pending.once('continue', resolve));
    pending.flushHeaders();
    await accepted;
    pending.write(body.slice(0, -1));
    doneToken.mockReturnValue('replacement-token');
    pending.end(body.slice(-1));
    expect(await response).toBe(403);
    expect(coord.signalDone).not.toHaveBeenCalled();
  });
});

// The global agent gate does not revoke manual phone access or completion reports.
describe('global orchestration policy on legacy HTTP routes', () => {
  let enabled: boolean;
  let coord: Coordinator;
  let srv: Awaited<ReturnType<typeof startRemoteServer>>;

  beforeEach(async () => {
    enabled = true;
    coord = makeMockCoordinator();
    srv = await startServer(coord, () => enabled);
  });

  afterEach(async () => {
    await srv.stop();
  });

  it.each([
    ['GET', '/api/tasks'],
    ['GET', `/api/tasks/${taskA.id}`],
    ['GET', `/api/tasks/${taskA.id}/diff`],
    ['GET', `/api/tasks/${taskA.id}/output`],
    ['POST', '/api/tasks'],
    ['POST', '/api/wait-signal'],
    ['POST', `/api/tasks/${taskA.id}/prompt`],
    ['POST', `/api/tasks/${taskA.id}/merge`],
    ['POST', `/api/tasks/${taskA.id}/review-merge`],
    ['DELETE', `/api/tasks/${taskA.id}`],
  ])('blocks coordinator %s %s after disabling orchestration', async (method, path) => {
    expect((await get('/api/tasks', COORD_A)).status).toBe(200);
    enabled = false;
    const response = await httpRequest(
      method,
      path,
      method === 'POST' ? { name: 'child', prompt: 'Continue' } : undefined,
      COORD_A,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Agent orchestration is disabled in Settings > MCP.',
    });
    for (const operation of [coord.createTask, coord.sendPrompt, coord.mergeTask, coord.closeTask])
      expect(operation).not.toHaveBeenCalled();
  });

  it('rechecks the policy after reading an in-flight coordinator request body', async () => {
    const body = JSON.stringify({ name: 'child', prompt: 'Continue' });
    const pending = http.request({
      hostname: '127.0.0.1',
      port: srv.port,
      path: '/api/tasks',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${srv.token}`,
        'X-Coordinator-Id': COORD_A,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Expect: '100-continue',
      },
    });
    const response = new Promise<number>((resolve, reject) => {
      pending.on('error', reject);
      pending.on('response', (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
    });
    const accepted = new Promise<void>((resolve) => pending.once('continue', resolve));
    pending.flushHeaders();
    await accepted;
    pending.write(body.slice(0, -1));
    enabled = false;
    pending.end(body.slice(-1));
    expect(await response).toBe(403);
    expect(coord.createTask).not.toHaveBeenCalled();
  });

  it('blocks child landing but permits only authenticated completion reports', async () => {
    enabled = false;
    const childRequest = (route: string, doneToken?: string) =>
      fetch(`http://127.0.0.1:${srv.port}/api/tasks/${taskA.id}/${route}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${srv.subtaskToken}`,
          'Content-Type': 'application/json',
          ...(doneToken === undefined ? {} : { 'X-Done-Token': doneToken }),
        },
        body: JSON.stringify(
          route === 'done'
            ? { result: completionReport }
            : { verification: completionReport.verification },
        ),
      });
    expect((await childRequest('land', DONE_TOKENS[taskA.id])).status).toBe(403);
    expect(coord.landSelf).not.toHaveBeenCalled();
    expect((await childRequest('done')).status).toBe(403);
    expect((await childRequest('done', DONE_TOKENS[taskB.id])).status).toBe(403);
    expect(coord.signalDone).not.toHaveBeenCalled();
    expect((await childRequest('done', DONE_TOKENS[taskA.id])).status).toBe(200);
    expect(coord.signalDone).toHaveBeenCalledExactlyOnceWith(
      taskA.id,
      { result: completionReport },
      expect.any(Function),
    );
    expect((await post(`/api/tasks/${taskA.id}/done`, {}, COORD_A)).status).toBe(200);
    expect((await post(`/api/tasks/${taskB.id}/done`, {}, COORD_A)).status).toBe(403);
  });

  it('keeps trusted phone agent access available while orchestration is disabled', async () => {
    enabled = false;
    const response = await fetch(`http://127.0.0.1:${srv.port}/api/agents`, {
      headers: { Authorization: `Bearer ${srv.mobileToken}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
});
