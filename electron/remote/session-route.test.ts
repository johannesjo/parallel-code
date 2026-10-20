import http from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getAgentMeta } from '../ipc/pty.js';
import type { SessionCapabilities } from '../shared/delegation-types.js';
import { startRemoteServer } from './server.js';

vi.mock('../ipc/pty.js', () => ({
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(),
  subscribeToAgentRendered: vi.fn(() => null),
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => []),
  getAgentCols: vi.fn(() => 80),
  onPtyEvent: vi.fn(() => vi.fn()),
  getAgentMeta: vi.fn(),
}));

let server: Awaited<ReturnType<typeof startRemoteServer>>;
let orchestrationEnabled = true;
const dispatch = vi.fn(async () => ({ remaining: 0 }));
const capabilities: SessionCapabilities = { profile: 'ordinary', canCreate: true, peers: true };
const session = (sessionInstanceId = 'launch-1') => ({ sessionInstanceId, capabilities });
const request = (
  token: string,
  body: unknown = { name: 'list_tasks', params: {} },
  headers: Record<string, string> = {},
  method = 'POST',
) =>
  fetch(`http://127.0.0.1:${server.port}/api/session/tools`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });

beforeEach(async () => {
  vi.clearAllMocks();
  orchestrationEnabled = true;
  dispatch.mockResolvedValue({ remaining: 0 });
  vi.mocked(getAgentMeta).mockReturnValue({ taskId: 'parent', agentId: 'agent', isShell: false });
  server = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: '/nonexistent',
    getTaskName: (id) => id,
    getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
    getCoordinator: () => null,
    callSessionTool: dispatch,
    isOrchestrationEnabled: () => orchestrationEnabled,
  });
});
afterEach(async () => {
  await server.stop();
});

it('uses the authenticated launch identity, never caller-supplied ownership or coordinator headers', async () => {
  const token = server.registerCanvasAgent('parent', 'agent', undefined, session());
  const params = { taskId: 'other', coordinatorTaskId: 'other', projectRoot: '/other' };
  const response = await request(
    token,
    { name: 'get_task_status', params, taskId: 'forged', sessionInstanceId: 'forged' },
    { 'X-Coordinator-Id': 'forged' },
  );
  expect(response.status).toBe(200);
  expect(dispatch).toHaveBeenCalledWith(
    { taskId: 'parent', agentId: 'agent', ...session() },
    'get_task_status',
    params,
  );
  expect(server.getSessionAgents()).toEqual([{ taskId: 'parent', agentId: 'agent', ...session() }]);
});

it('denies coordinator, subtask, mobile, paired, legacy canvas and unknown tokens', async () => {
  const pairing = await fetch(`http://127.0.0.1:${server.port}/api/pair/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.mobileToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: server.generatePairingPin().pin }),
  });
  expect(pairing.status).toBe(201);
  const paired = (await pairing.json()) as { token: string };
  const canvas = server.registerCanvasAgent('parent', 'agent');
  for (const token of [server.token, server.subtaskToken, server.mobileToken, paired.token, canvas])
    expect((await request(token, undefined, { 'X-Coordinator-Id': 'parent' })).status).toBe(403);
  expect((await request('unknown')).status).toBe(401);
  expect(dispatch).not.toHaveBeenCalled();
});

it('reuses a live launch token without expanding its mint-time capabilities', async () => {
  const token = server.registerCanvasAgent('parent', 'agent', undefined, {
    sessionInstanceId: 'launch-1',
    capabilities: { ...capabilities, canCreate: false },
  });
  expect(server.registerCanvasAgent('parent', 'agent', undefined, session())).toBe(token);
  expect((await request(token)).status).toBe(200);
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ capabilities: { ...capabilities, canCreate: false } }),
    'list_tasks',
    {},
  );
});

it('rotates replacement-launch credentials and revokes old routes immediately', async () => {
  const old = server.registerCanvasAgent('parent', 'agent', undefined, session());
  const replacement = server.registerCanvasAgent('parent', 'agent', undefined, session('launch-2'));
  expect(replacement).not.toBe(old);
  expect((await request(old)).status).toBe(401);
  expect((await request(replacement)).status).toBe(200);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ sessionInstanceId: 'launch-2' }),
    'list_tasks',
    {},
  );
  expect(server.getSessionAgents()).toEqual([
    { taskId: 'parent', agentId: 'agent', ...session('launch-2') },
  ]);
  server.unregisterCanvasAgent('agent');
  expect((await request(replacement)).status).toBe(401);
  expect(server.getSessionAgents()).toEqual([]);
});

it('checks current liveness and retains custom active checks', async () => {
  let active = true;
  const token = server.registerCanvasAgent('parent', 'agent', () => active, session());
  vi.mocked(getAgentMeta).mockReturnValue(null);
  expect((await request(token)).status).toBe(200);
  active = false;
  expect((await request(token)).status).toBe(403);
  expect(server.getSessionAgents()).toEqual([]);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it('rejects a task-mismatched PTY when there is no custom active check', async () => {
  const token = server.registerCanvasAgent('parent', 'agent', undefined, session());
  vi.mocked(getAgentMeta).mockReturnValue({
    taskId: 'different',
    agentId: 'agent',
    isShell: false,
  });
  expect((await request(token)).status).toBe(403);
  expect(server.getSessionAgents()).toEqual([]);
  expect(dispatch).not.toHaveBeenCalled();
});

it.each(['replace', 'deactivate', 'disable orchestration'] as const)(
  'rechecks %s after reading an in-flight request body',
  async (change) => {
    let active = true;
    const token = server.registerCanvasAgent('parent', 'agent', () => active, session());
    const body = JSON.stringify({ name: 'create_task', params: {} });
    const pending = http.request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/api/session/tools',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
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
    if (change === 'replace')
      server.registerCanvasAgent('parent', 'agent', () => true, session('replacement'));
    else if (change === 'deactivate') active = false;
    else orchestrationEnabled = false;
    pending.end(body.slice(-1));
    expect(await response).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
  },
);

it('validates the request shape and method before dispatch', async () => {
  const token = server.registerCanvasAgent('parent', 'agent', undefined, session());
  for (const body of [
    null,
    [],
    {},
    { name: 1, params: {} },
    { name: 'list_tasks', params: [] },
    { name: 'list_tasks', params: null },
  ])
    expect((await request(token, body)).status).toBe(400);
  expect((await request(token, undefined, {}, 'GET')).status).toBe(405);
  expect(dispatch).not.toHaveBeenCalled();
});

it('does not let session credentials use legacy task routes or browser-origin requests', async () => {
  const token = server.registerCanvasAgent('parent', 'agent', undefined, session());
  expect(
    (
      await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Coordinator-Id': 'parent' },
      })
    ).status,
  ).toBe(403);
  expect((await request(token, undefined, { Origin: 'https://untrusted.example' })).status).toBe(
    403,
  );
  expect(dispatch).not.toHaveBeenCalled();
});

it('revokes existing session orchestration immediately while allowing completion', async () => {
  const token = server.registerCanvasAgent('parent', 'agent', undefined, session());
  expect((await request(token)).status).toBe(200);
  dispatch.mockClear();
  orchestrationEnabled = false;
  for (const name of ['list_tasks', 'create_task', 'send_agent_prompt', 'close_task']) {
    const response = await request(token, { name, params: {} });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Agent orchestration is disabled in Settings > MCP.',
    });
  }
  expect(dispatch).not.toHaveBeenCalled();
  expect((await request(token, { name: 'signal_done', params: {} })).status).toBe(200);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(
    { taskId: 'parent', agentId: 'agent', ...session() },
    'signal_done',
    {},
  );
  orchestrationEnabled = true;
  expect((await request(token)).status).toBe(200);
});
