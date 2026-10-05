// The canvas channels need a window with an ipcRenderer, so this runs in the
// client (happy-dom) config over the real store; only IPC and saving are mocked.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { setStore, store } from './core';
import { startRemoteTaskHandlers } from './remoteTaskHandler';
import type { Task } from './types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('./persistence', () => ({ saveState: vi.fn(async () => undefined) }));

const tourCard = { label: 'KEY DECISION', title: 'One idea', body: 'Body text.' };
const tourPayload = { subject: 'the retry bug', gist: tourCard, cards: [tourCard] };

const listeners = new Map<string, (payload: unknown) => void>();
let stop: (() => void) | undefined;
const task: Task = {
  id: 'task',
  name: 'Task',
  projectId: 'project',
  branchName: 'task/test',
  worktreePath: '/tmp/task',
  agentIds: ['agent'],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
};

beforeEach(() => {
  Object.assign(window, {
    electron: {
      ipcRenderer: {
        on: (channel: string, cb: (payload: unknown) => void) => {
          listeners.set(channel, cb);
          return () => listeners.delete(channel);
        },
      },
    },
  });
  setStore('tasks', reconcile({ task: { ...task }, closing: { ...task, id: 'closing' } }));
  setStore('tasks', 'closing', 'closingStatus', 'closing');
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  stop = startRemoteTaskHandlers();
});
afterEach(() => {
  stop?.();
  // Stopping must unsubscribe every channel it registered.
  expect(listeners.size).toBe(0);
});

/** Sends one request and returns the reply the main process would forward. */
async function request(channel: string, payload: Record<string, unknown>) {
  vi.mocked(invoke).mockClear();
  listeners.get(channel)?.({ reqId: 'req', ...payload });
  await Promise.resolve();
  await Promise.resolve();
  const reply = vi.mocked(invoke).mock.calls.find(([c]) => c === IPC.Remote_RendererReply);
  return reply?.[1] as { ok: boolean; data?: unknown; error?: string } | undefined;
}

const canvasChannels = [
  { channel: IPC.MCP_ReadMindMapRequest, payload: {} },
  {
    channel: IPC.MCP_UpdateMindMapRequest,
    payload: { update: { expectedRevision: 0, operations: [] } },
  },
  { channel: IPC.MCP_ReadReasoningRequest, payload: {} },
  {
    channel: IPC.MCP_UpdateReasoningRequest,
    payload: { update: { runId: 'run', expectedRevision: 1, operations: [] } },
  },
  { channel: IPC.MCP_OpenCanvasRequest, payload: { view: 'mindmap' } },
  { channel: IPC.MCP_PublishTourRequest, payload: { payload: tourPayload } },
];

it.each(canvasChannels)(
  'rejects unknown, inherited, and closing task IDs with a plain message: $channel',
  async ({ channel, payload }) => {
    for (const taskId of ['missing', '__proto__', 'constructor', 'closing']) {
      const reply = await request(channel, { taskId, ...payload });
      expect(reply?.ok).toBe(false);
      expect(reply?.error).toBe('Task not available.');
    }
    expect(Object.hasOwn(store.tasks, '__proto__')).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'mindMap')).toBe(false);
    expect(store.tasks.task.mindMap).toBeUndefined();
  },
);

it('reports a stale mind map revision without the Error prefix and keeps the map', async () => {
  const read = await request(IPC.MCP_ReadMindMapRequest, { taskId: 'task' });
  expect(read?.ok).toBe(true);
  const map = read?.data as { revision: number; records: Array<{ id: string }> };
  const parent = map.records[0].id;
  const insert = {
    type: 'insert',
    node: { id: 'child', parent, title: 'Child', detail: '' },
  };
  const stale = await request(IPC.MCP_UpdateMindMapRequest, {
    taskId: 'task',
    update: { expectedRevision: map.revision + 1, operations: [insert] },
  });
  expect(stale?.ok).toBe(false);
  expect(stale?.error).toMatch(/changed\. Read it again/i);
  expect(stale?.error?.startsWith('Error:')).toBe(false);
  expect(store.tasks.task.mindMap?.records.some((record) => record.id === 'child')).toBe(false);
  const fresh = await request(IPC.MCP_UpdateMindMapRequest, {
    taskId: 'task',
    update: { expectedRevision: map.revision, operations: [insert] },
  });
  expect(fresh?.ok).toBe(true);
  expect(store.tasks.task.mindMap?.records.some((record) => record.id === 'child')).toBe(true);
});

it('publishes an agent tour for a known task and bumps its revision', async () => {
  const first = await request(IPC.MCP_PublishTourRequest, {
    taskId: 'task',
    payload: tourPayload,
  });
  expect(first).toEqual({ reqId: 'req', ok: true, data: { ok: true }, error: undefined });
  expect(store.tasks.task.agentTour).toEqual({ revision: 1, payload: tourPayload });
  const second = await request(IPC.MCP_PublishTourRequest, {
    taskId: 'task',
    payload: { ...tourPayload, subject: 'another topic' },
  });
  expect(second?.ok).toBe(true);
  expect(store.tasks.task.agentTour?.revision).toBe(2);
  const invalid = await request(IPC.MCP_PublishTourRequest, {
    taskId: 'task',
    payload: { ...tourPayload, gist: 'text' },
  });
  expect(invalid?.ok).toBe(false);
  expect(invalid?.error).toBe('gist must be an object.');
  expect(store.tasks.task.agentTour?.revision).toBe(2);
});

it('opens a canvas view for a known task only', async () => {
  const opened = await request(IPC.MCP_OpenCanvasRequest, { taskId: 'task', view: 'reasoning' });
  expect(opened).toEqual({ reqId: 'req', ok: true, data: { ok: true }, error: undefined });
  expect(store.tasks.task.canvasActiveTab).toBe('reasoning');
  const invalid = await request(IPC.MCP_OpenCanvasRequest, { taskId: 'task', view: 'browser' });
  expect(invalid?.ok).toBe(false);
  expect(typeof invalid?.error).toBe('string');
});

it('adds a task created from a phone without taking focus from the active task', async () => {
  const agentDef = {
    id: 'claude',
    name: 'Claude',
    command: 'claude',
    args: [],
    resume_args: [],
    skip_permissions_args: [],
    description: '',
  };
  setStore('projects', [
    { id: 'project', name: 'Project', path: '/tmp/project', color: '', defaultBaseBranch: 'main' },
  ]);
  setStore('availableAgents', [agentDef]);
  setStore('taskOrder', ['task']);
  setStore('activeTaskId', 'task');
  setStore('activeAgentId', 'agent');
  vi.mocked(invoke).mockImplementation(async (channel: string) => {
    if (channel === IPC.GetGitignoredDirs) return [];
    if (channel === IPC.CreateTask)
      return { id: 'phone-task', branch_name: 'task/phone', worktree_path: '/tmp/phone' };
    return undefined;
  });

  listeners.get(IPC.Remote_CreateTaskRequest)?.({
    reqId: 'req',
    projectId: 'project',
    name: 'From phone',
    prompt: 'Do it',
  });
  await vi.waitFor(() =>
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      IPC.Remote_RendererReply,
      expect.objectContaining({ ok: true, data: { taskId: 'phone-task' } }),
    ),
  );

  expect(store.taskOrder).toContain('phone-task');
  expect(store.activeTaskId).toBe('task');
  expect(store.activeAgentId).toBe('agent');
});

/** Replies to the close request once the handler has finished. */
async function closeRequest(force: boolean) {
  listeners.get(IPC.Remote_CloseTaskRequest)?.({ reqId: 'req', taskId: 'task', force });
  await vi.waitFor(() =>
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.Remote_RendererReply, expect.anything()),
  );
  const reply = vi.mocked(invoke).mock.calls.find(([c]) => c === IPC.Remote_RendererReply);
  return reply?.[1] as { ok: boolean; data?: unknown; error?: string };
}

it('refuses to close a task with unsaved work unless forced', async () => {
  vi.mocked(invoke).mockImplementation(async (channel: string) =>
    channel === IPC.GetWorktreeStatus
      ? { has_uncommitted_changes: true, has_committed_changes: false }
      : undefined,
  );

  const reply = await closeRequest(false);

  expect(reply).toMatchObject({
    ok: true,
    data: {
      closed: false,
      warnings: ['There are uncommitted changes that will be permanently lost.'],
    },
  });
  expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(IPC.DeleteTask, expect.anything());
  expect(store.tasks.task.closingStatus).toBeUndefined();
});

it('closes a clean task without forcing', async () => {
  vi.mocked(invoke).mockImplementation(async (channel: string) =>
    channel === IPC.GetWorktreeStatus
      ? { has_uncommitted_changes: false, has_committed_changes: false }
      : undefined,
  );

  const reply = await closeRequest(false);

  expect(reply).toMatchObject({ ok: true, data: { closed: true } });
  expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.DeleteTask, expect.anything());
});

it('force-closes without checking the worktree', async () => {
  const reply = await closeRequest(true);

  expect(reply).toMatchObject({ ok: true, data: { closed: true } });
  expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(IPC.GetWorktreeStatus, expect.anything());
  expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.DeleteTask, expect.anything());
});

it('reports an unknown task instead of closing', async () => {
  listeners.get(IPC.Remote_CloseTaskRequest)?.({ reqId: 'req', taskId: 'missing', force: true });
  await vi.waitFor(() =>
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      IPC.Remote_RendererReply,
      expect.objectContaining({ ok: false, error: 'Task not found' }),
    ),
  );
});

it('answers a phone diff request with the task diff against its base', async () => {
  setStore('tasks', 'task', 'baseBranch', 'main');
  vi.mocked(invoke).mockImplementation(async (channel: string) =>
    channel === IPC.GetAllFileDiffs ? 'diff --git a/x b/x' : undefined,
  );

  listeners.get(IPC.Remote_GetDiffRequest)?.({ reqId: 'req', taskId: 'task' });

  await vi.waitFor(() =>
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      IPC.Remote_RendererReply,
      expect.objectContaining({
        ok: true,
        data: { diff: 'diff --git a/x b/x', truncated: false },
      }),
    ),
  );
  expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.GetAllFileDiffs, {
    worktreePath: '/tmp/task',
    baseBranch: 'main',
  });
});

/** Sends one commit-channel request and waits for its reply. */
async function commitRequest(channel: string, payload: Record<string, unknown>) {
  vi.mocked(invoke).mockClear();
  listeners.get(channel)?.({ reqId: 'req', taskId: 'task', ...payload });
  await vi.waitFor(() =>
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.Remote_RendererReply, expect.anything()),
  );
  const reply = vi.mocked(invoke).mock.calls.find(([c]) => c === IPC.Remote_RendererReply);
  return reply?.[1] as { ok: boolean; data?: unknown; error?: string };
}

function mockWorktreeChanges(): void {
  vi.mocked(invoke).mockImplementation(async (channel: string) => {
    if (channel === IPC.GetUncommittedChangedFiles)
      return [
        { path: 'a.ts', status: 'M', lines_added: 1, lines_removed: 0, committed: false },
        { path: 'b.ts', status: '?', lines_added: 2, lines_removed: 0, committed: false },
      ];
    if (channel === IPC.GetStagedFiles) return ['a.ts'];
    return undefined;
  });
}

it('lists uncommitted files with their staged state for the phone', async () => {
  mockWorktreeChanges();

  const reply = await commitRequest(IPC.Remote_GetCommitStatusRequest, {});

  expect(reply).toEqual({
    reqId: 'req',
    ok: true,
    data: {
      files: [
        { path: 'a.ts', status: 'M', staged: true },
        { path: 'b.ts', status: '?', staged: false },
      ],
    },
    error: undefined,
  });
});

it('marks a task without its own worktree as unsupported for commits', async () => {
  setStore('tasks', 'task', 'gitIsolation', 'none');

  const status = await commitRequest(IPC.Remote_GetCommitStatusRequest, {});
  expect(status).toMatchObject({ ok: true, data: { files: [], unsupported: true } });

  const action = await commitRequest(IPC.Remote_CommitActionRequest, { action: 'stage-all' });
  expect(action.ok).toBe(false);
  expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(IPC.StageAll, expect.anything());
});

it.each([
  { action: 'stage-all', channel: IPC.StageAll, args: { worktreePath: '/tmp/task' } },
  { action: 'unstage-all', channel: IPC.UnstageAll, args: { worktreePath: '/tmp/task' } },
  {
    action: 'commit',
    channel: IPC.CommitStaged,
    args: { worktreePath: '/tmp/task', message: 'fix it' },
  },
])('runs $action in the task worktree and answers the new status', async (c) => {
  mockWorktreeChanges();

  const reply = await commitRequest(IPC.Remote_CommitActionRequest, {
    action: c.action,
    message: 'fix it',
  });

  expect(vi.mocked(invoke)).toHaveBeenCalledWith(c.channel, c.args);
  expect(reply).toMatchObject({ ok: true, data: { files: expect.any(Array) } });
});

it('reports a failed commit to the phone', async () => {
  vi.mocked(invoke).mockImplementation(async (channel: string) => {
    if (channel === IPC.CommitStaged) throw new Error('nothing to commit');
    return undefined;
  });

  const reply = await commitRequest(IPC.Remote_CommitActionRequest, {
    action: 'commit',
    message: 'x',
  });

  expect(reply).toMatchObject({ ok: false, error: 'nothing to commit' });
});
