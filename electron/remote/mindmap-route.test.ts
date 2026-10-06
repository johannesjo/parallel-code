import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMindMap, applyMapOperations } from '../shared/mindmap.js';
import type { Coordinator } from '../mcp/coordinator.js';
import { MCPClient } from '../mcp/client.js';
import { getAgentMeta } from '../ipc/pty.js';
import { startRemoteServer } from './server.js';
import type { AgentTourPayload } from '../shared/agent-tour.js';
import { appendReasoningUpdate, readReasoningFeed } from '../ipc/reasoning.js';
import { parseReasoningFeed } from '../shared/reasoning-feed.js';
import type { ReasoningDocument } from '../shared/reasoning.js';
import type { ReasoningUpdate } from '../shared/reasoning-state.js';

vi.mock('../ipc/git-exclude.js', () => ({ appendGitInfoExcludeBlock: () => 'appended' }));

vi.mock('../ipc/pty.js', () => ({
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(),
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => []),
  getAgentCols: vi.fn(() => 80),
  onPtyEvent: vi.fn(() => vi.fn()),
  getAgentMeta: vi.fn(),
}));

let server: Awaited<ReturnType<typeof startRemoteServer>>;
let client: MCPClient;
let coordinator: Coordinator | null = null;
let token: string;
let map = createMindMap();
let reportDirectory: string;
const initialReport: ReasoningUpdate = {
  runId: null,
  newRunId: 'run',
  expectedRevision: 0,
  caption: 'Start',
  operations: [
    {
      type: 'insert',
      node: { id: 'goal', kind: 'goal', title: 'Investigate', detail: '', status: 'unresolved' },
    },
  ],
};
const readReasoning = vi.fn(async (taskId: string): Promise<ReasoningDocument> => {
  const read = await readReasoningFeed({ worktreePath: reportDirectory, taskId, agentId: 'agent' });
  const parsed = parseReasoningFeed(read && 'raw' in read ? read.raw : '');
  const report = parsed.history.snapshots[parsed.history.snapshots.length - 1] ?? null;
  return {
    runId: parsed.history.updates[0]?.runId ?? null,
    revision: report?.revision ?? 0,
    workflow: 'investigation',
    graph: report,
  };
});
const updateReasoning = vi.fn(async (taskId: string, update: ReasoningUpdate) => {
  appendReasoningUpdate(reportDirectory, taskId, 'agent', update);
  return readReasoning(taskId);
});
const openCanvas = vi.fn(async (_taskId: string, _view: 'mindmap' | 'reasoning') => {});
const publishTour = vi.fn(async (_taskId: string, _payload: AgentTourPayload) => ({ ok: true }));
const submitEvidence = vi.fn(async (_taskId: string, _submission: unknown) => ({
  status: 'building',
}));
const getEvidence = vi.fn(async (_taskId: string) => ({ status: 'none', checks: [] }));
const read = vi.fn(async (_taskId: string) => structuredClone(map));
const update = vi.fn(
  async (
    _taskId: string,
    input: { operations: Parameters<typeof applyMapOperations>[1]; expectedRevision: number },
  ) => {
    map = applyMapOperations(map, input.operations, input.expectedRevision, 'agent');
    return structuredClone(map);
  },
);

beforeEach(async () => {
  map = createMindMap();
  coordinator = null;
  vi.clearAllMocks();
  reportDirectory = mkdtempSync(join(tmpdir(), 'reasoning-route-'));
  vi.mocked(getAgentMeta).mockReturnValue({ taskId: 'task-1', agentId: 'agent-1', isShell: false });
  server = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: '/nonexistent',
    getTaskName: (id) => id,
    getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
    getCoordinator: () => coordinator,
    readMindMap: read,
    updateMindMap: update,
    readReasoning,
    updateReasoning,
    openCanvas,
    publishTour,
    submitEvidence,
    getEvidence,
  });
  token = server.registerCanvasAgent('task-1', 'agent-1');
  client = new MCPClient(`http://127.0.0.1:${server.port}`, token);
});
afterEach(async () => {
  await server?.stop();
  rmSync(reportDirectory, { recursive: true, force: true });
});

it('publishes reasoning reports through the scoped MCP client and rejects stale updates', async () => {
  expect((await client.readReasoning('task-1')).revision).toBe(0);
  const result = await client.updateReasoning('task-1', initialReport);
  expect(result.graph?.records[0].title).toBe('Investigate');
  expect(result.revision).toBe(1);
  await expect(client.updateReasoning('task-1', initialReport)).rejects.toThrow(
    'revision or run changed',
  );
  expect(await client.readReasoning('task-1')).toEqual(result);
  await expect(client.readReasoning('task-2')).rejects.toThrow('403');
  await expect(client.updateReasoning('task-2', initialReport)).rejects.toThrow('403');
  vi.mocked(getAgentMeta).mockReturnValue(null);
  await expect(client.readReasoning('task-1')).rejects.toThrow('403');
});

it('reads and updates the authoritative map through the MCP HTTP client', async () => {
  const initial = await client.readMindMap('task-1');
  const result = await client.updateMindMap('task-1', {
    expectedRevision: initial.revision,
    operations: [
      {
        type: 'insert',
        node: {
          id: 'child',
          parent: initial.records[0].id,
          title: 'Agent idea',
          detail: 'Evidence',
        },
      },
    ],
  });
  expect(result.records[1].title).toBe('Agent idea');
  expect(result.revision).toBe(1);
  expect(await client.readMindMap('task-1')).toEqual(result);
  await expect(
    client.updateMindMap('task-1', {
      expectedRevision: 0,
      operations: [{ type: 'remove', id: 'child' }],
    }),
  ).rejects.toThrow('Read it again');
  expect(map.records).toHaveLength(2);
});

it('scopes chat canvas credentials to their live session independently of terminals', async () => {
  let active = true;
  const chatToken = server.registerCanvasAgent('task-1', 'chat-session', () => active);
  const headers = { Authorization: `Bearer ${chatToken}` };
  const request = (task: string) =>
    fetch(`http://127.0.0.1:${server.port}/api/mindmaps/${task}`, { headers });
  vi.mocked(getAgentMeta).mockReturnValue(null);
  expect(server.hasCanvasAgents()).toBe(true);
  expect((await request('task-1')).status).toBe(200);
  expect((await request('task-2')).status).toBe(403);
  active = false;
  expect(server.hasCanvasAgents()).toBe(false);
  expect((await request('task-1')).status).toBe(403);
  server.unregisterCanvasAgent('chat-session');
  expect((await request('task-1')).status).not.toBe(200);
});

it('opens canvas views for the owning task only and validates the view', async () => {
  await expect(client.openCanvas('task-1', 'reasoning')).resolves.toEqual({
    ok: true,
    view: 'reasoning',
  });
  expect(openCanvas).toHaveBeenCalledWith('task-1', 'reasoning');
  await expect(client.openCanvas('task-2', 'mindmap')).rejects.toThrow('403');
  const endpoint = `http://127.0.0.1:${server.port}/api/canvas/task-1`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const unknown = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ view: 'browser' }),
  });
  expect(unknown.status).toBe(400);
  expect((await fetch(endpoint, { headers })).status).toBe(405);
  expect(openCanvas).toHaveBeenCalledTimes(1);
});

it('publishes a tour for the owning task only and validates the payload', async () => {
  const card = { label: 'KEY DECISION', title: 'One idea', body: 'Body text.' };
  const tour = { subject: 'the retry bug', gist: card, cards: [card], context: 'The facts.' };
  await expect(client.publishTour('task-1', tour)).resolves.toEqual({
    ok: true,
    subject: 'the retry bug',
  });
  expect(publishTour).toHaveBeenCalledWith('task-1', tour);
  await expect(client.publishTour('task-2', tour)).rejects.toThrow('403');
  const endpoint = `http://127.0.0.1:${server.port}/api/tours/task-1`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const malformed = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...tour, cards: [] }),
  });
  expect(malformed.status).toBe(400);
  const huge = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...tour, context: 'x'.repeat(300 * 1024) }),
  });
  expect(huge.status).toBe(413);
  expect((await fetch(endpoint, { headers })).status).toBe(405);
  expect(publishTour).toHaveBeenCalledTimes(1);
});

it('accepts evidence for the owning task only and rejects app-owned fields', async () => {
  const submission = { summary: 'Adds retries', notVerified: ['Safari'] };
  await expect(client.submitEvidence('task-1', submission)).resolves.toEqual({
    status: 'building',
  });
  expect(submitEvidence).toHaveBeenCalledWith('task-1', submission);
  await expect(client.getEvidence('task-1')).resolves.toEqual({ status: 'none', checks: [] });
  await expect(client.submitEvidence('task-2', submission)).rejects.toThrow('403');
  await expect(client.getEvidence('task-2')).rejects.toThrow('403');
  const endpoint = `http://127.0.0.1:${server.port}/api/evidence/task-1`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const forged = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ confidence: 'high' }),
  });
  expect(forged.status).toBe(400);
  expect(submitEvidence).toHaveBeenCalledTimes(1);
});

it('rejects access to other tasks, terminals, task control and device pairing', async () => {
  await expect(client.readMindMap('task-2')).rejects.toThrow('403');
  for (const path of [
    '/api/agents',
    '/api/tasks',
    '/api/mobile/notes/task-1',
    '/api/pair/verify',
  ]) {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
  }
  expect(read).not.toHaveBeenCalled();
});

it('rejects unscoped existing credentials and inactive canvas agents', async () => {
  for (const credential of [server.mobileToken, server.subtaskToken, server.token])
    await expect(
      new MCPClient(`http://127.0.0.1:${server.port}`, credential).readMindMap('task-1'),
    ).rejects.toThrow('403');
  vi.mocked(getAgentMeta).mockReturnValue(null);
  await expect(client.readMindMap('task-1')).rejects.toThrow('403');
});

it('rejects malformed operations before calling the renderer and disallows browser origins', async () => {
  const endpoint = `http://127.0.0.1:${server.port}/api/mindmaps/task-1`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const malformed = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ expectedRevision: 0, operations: [{ type: 'oops', id: 'root' }] }),
  });
  expect(malformed.status).toBe(400);
  expect(update).not.toHaveBeenCalled();
  const browser = await fetch(endpoint, {
    headers: { ...headers, Origin: 'https://untrusted.example' },
  });
  expect(browser.status).toBe(403);
  const badId = await fetch(`http://127.0.0.1:${server.port}/api/mindmaps/%ZZ`, { headers });
  expect(badId.status).toBe(400);
});

it('keeps canvas credentials valid when remote access changes the listening interface', async () => {
  expect(server.registerCanvasAgent('task-1', 'agent-1')).toBe(token);
  await client.readMindMap('task-1');
  await server.rebind('0.0.0.0');
  expect(server.bindHost).toBe('0.0.0.0');
  expect(await client.readMindMap('task-1')).toEqual(map);
});

it('serves discoverable tools over real MCP stdio and reflects subsequent manual edits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mindmap-mcp-smoke-'));
  const binary = join(directory, 'server.cjs');
  buildSync({
    entryPoints: ['electron/mcp/server.ts'],
    outfile: binary,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const mcp = new Client({ name: 'mindmap-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      binary,
      '--url',
      `http://127.0.0.1:${server.port}`,
      '--task-id',
      'task-1',
      '--canvas-only',
    ],
    env: { NODE_ENV: 'production', PARALLEL_CODE_MCP_TOKEN: token },
  });
  try {
    await mcp.connect(transport);
    expect(mcp.getInstructions()).toContain('Reasoning graph');
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual([
      'mindmap_read',
      'mindmap_update',
      'reasoning_read',
      'reasoning_update',
      'canvas_open',
      'tour_publish',
      'submit_evidence',
      'get_evidence',
    ]);
    const opened = await mcp.callTool({ name: 'canvas_open', arguments: { view: 'mindmap' } });
    expect(opened.isError).not.toBe(true);
    expect(openCanvas).toHaveBeenCalledWith('task-1', 'mindmap');
    const read = await mcp.callTool({ name: 'mindmap_read', arguments: {} });
    expect(read.isError).not.toBe(true);
    const changed = await mcp.callTool({
      name: 'mindmap_update',
      arguments: {
        expectedRevision: 0,
        operations: [
          {
            type: 'insert',
            node: { id: 'topic', parent: map.records[0].id, title: 'From the agent', detail: '' },
          },
        ],
      },
    });
    expect(changed.isError).not.toBe(true);
    expect(map.records[1].title).toBe('From the agent');
    map = applyMapOperations(map, [
      { type: 'update', id: 'topic', changes: { title: 'Edited on canvas' } },
    ]);
    const latest = await mcp.callTool({ name: 'mindmap_read', arguments: {} });
    expect(JSON.stringify(latest.content)).toContain('Edited on canvas');
    const stale = await mcp.callTool({
      name: 'mindmap_update',
      arguments: { expectedRevision: 1, operations: [{ type: 'remove', id: 'topic' }] },
    });
    expect(stale.isError).toBe(true);
    expect(map.records[1].title).toBe('Edited on canvas');
    const report = await mcp.callTool({ name: 'reasoning_read', arguments: {} });
    expect(report.isError).not.toBe(true);
    const published = await mcp.callTool({
      name: 'reasoning_update',
      arguments: { ...initialReport },
    });
    expect(published.isError).not.toBe(true);
    expect((await client.readReasoning('task-1')).graph?.records[0].title).toBe('Investigate');
    const staleReport = await mcp.callTool({
      name: 'reasoning_update',
      arguments: { ...initialReport },
    });
    expect(staleReport.isError).toBe(true);
  } finally {
    await mcp.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('reuses coordinator and sub-task ownership without granting access to other maps', async () => {
  coordinator = {
    isRegisteredCoordinator: (id: string) => id === 'coordinator-1',
    getTaskDoneToken: (id: string) => (id === 'child-1' ? 'child-secret' : undefined),
  } as unknown as Coordinator;
  const url = `http://127.0.0.1:${server.port}`;
  const parent = new MCPClient(url, server.token, 'coordinator-1');
  await expect(parent.readMindMap('coordinator-1')).resolves.toEqual(map);
  await expect(parent.readMindMap('task-1')).rejects.toThrow('403');
  await expect(parent.readReasoning('coordinator-1')).resolves.toMatchObject({ revision: 0 });
  await expect(parent.readReasoning('task-1')).rejects.toThrow('403');
  const child = new MCPClient(url, server.subtaskToken, undefined, 'child-secret');
  await expect(child.readMindMap('child-1')).resolves.toEqual(map);
  await expect(child.readMindMap('task-1')).rejects.toThrow('403');
  await expect(child.readReasoning('child-1')).resolves.toMatchObject({ revision: 0 });
  await expect(child.readReasoning('task-1')).rejects.toThrow('403');
});

it('binds a coordinator agent token to the coordinator it was issued for', async () => {
  coordinator = {
    isRegisteredCoordinator: (id: string) => id === 'coordinator-1' || id === 'coordinator-2',
    getTaskDoneToken: () => undefined,
  } as unknown as Coordinator;
  const url = `http://127.0.0.1:${server.port}`;
  const agentToken = server.coordinatorTokenFor('coordinator-1');
  expect(agentToken).not.toBe(server.token);
  const own = new MCPClient(url, agentToken, 'coordinator-1');
  await expect(own.readReasoning('coordinator-1')).resolves.toMatchObject({ revision: 0 });
  // Another live coordinator's id in the header does not match the token.
  const forged = new MCPClient(url, agentToken, 'coordinator-2');
  await expect(forged.readReasoning('coordinator-2')).rejects.toThrow('401');
  await expect(forged.readMindMap('coordinator-2')).rejects.toThrow('401');
});

it('distinguishes oversized, conflicting and unavailable requests by status and caps concurrency', async () => {
  const endpoint = `http://127.0.0.1:${server.port}/api/mindmaps/task-1`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const oversized = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      expectedRevision: 0,
      operations: [{ type: 'remove', id: 'x'.repeat(9 * 1024 * 1024) }],
    }),
  });
  expect(oversized.status).toBe(413);
  const stale = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ expectedRevision: 5, operations: [{ type: 'remove', id: 'child' }] }),
  });
  expect(stale.status).toBe(409);
  read.mockRejectedValueOnce(new Error('Desktop app did not respond'));
  expect((await fetch(endpoint, { headers })).status).toBe(503);
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  read.mockImplementation(async () => {
    await blocked;
    return structuredClone(map);
  });
  read.mockClear();
  const inFlight = Array.from({ length: 4 }, () => fetch(endpoint, { headers }));
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    expect((await fetch(endpoint, { headers })).status).toBe(429);
  } finally {
    finish();
  }
  expect((await Promise.all(inFlight)).map((response) => response.status)).toEqual([
    200, 200, 200, 200,
  ]);
  // Slots are released after completion.
  expect((await fetch(endpoint, { headers })).status).toBe(200);
});
