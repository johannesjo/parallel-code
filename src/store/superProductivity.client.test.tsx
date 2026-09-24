// Behaviour of the Super Productivity sync over the real store and real
// solid-js reactivity (the node config compiles solid for SSR, where effects
// never run). Only the IPC layer is replaced, by a small in-memory fake of
// Super Productivity's REST API.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSignal } from 'solid-js';
import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import type { Task } from './types';
import {
  armSpCompletion,
  fireSpCompletion,
  onTaskRenamed,
  refreshSpConnection,
  spBanner,
  startSuperProductivitySync,
  trackTaskInSp,
} from './superProductivity';

interface FakeSpTask {
  id: string;
  title: string;
  isDone: boolean;
  projectId: string | null;
  parentId: string | null;
  notes: string;
}

const sp = vi.hoisted(() => ({
  tasks: new Map<string, FakeSpTask>(),
  current: null as string | null,
  isBreak: false,
  nextId: 1,
  creates: [] as Record<string, unknown>[],
  projects: [{ id: 'sp-proj', title: 'Proj' }] as { id: string; title: string }[],
}));

const { mockShowNotification } = vi.hoisted(() => ({ mockShowNotification: vi.fn() }));
vi.mock('./notification', () => ({ showNotification: mockShowNotification }));

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('../lib/ipc', () => ({ invoke: mockInvoke, Channel: vi.fn() }));

const ok = (value: unknown) => ({ ok: true, value });
const missing = { ok: false, reason: 'not_found' };

function fakeSp(channel: string, args: Record<string, unknown> = {}): unknown {
  const id = args.taskId as string;
  switch (channel) {
    case IPC.SuperProductivityGetState:
      return 'connected';
    case IPC.SuperProductivityListProjects:
      return ok(sp.projects);
    case IPC.SuperProductivityGetTracking:
      return ok({ current: sp.current ? sp.tasks.get(sp.current) : null, isBreak: sp.isBreak });
    case IPC.SuperProductivityGetTask:
      return sp.tasks.has(id) ? ok(sp.tasks.get(id)) : missing;
    case IPC.SuperProductivityGetTasks:
      return ok((args.taskIds as string[]).flatMap((t) => sp.tasks.get(t) ?? []));
    case IPC.SuperProductivityCreateTask: {
      sp.creates.push(args);
      const task: FakeSpTask = {
        id: `sp-${sp.nextId++}`,
        title: args.title as string,
        isDone: false,
        projectId: (args.projectId as string | undefined) ?? null,
        parentId: (args.parentId as string | undefined) ?? null,
        notes: '',
      };
      sp.tasks.set(task.id, task);
      return ok(task);
    }
    case IPC.SuperProductivityStartTracking:
      if (!sp.tasks.has(id)) return missing;
      sp.current = id;
      return ok(null);
    case IPC.SuperProductivityRenameTask: {
      const task = sp.tasks.get(id);
      if (!task) return missing;
      task.title = args.title as string;
      return ok(null);
    }
    case IPC.SuperProductivityCompleteTask: {
      const task = sp.tasks.get(id);
      if (!task) return missing;
      task.isDone = true;
      task.notes = args.note as string;
      return ok(null);
    }
    default:
      throw new Error(`unexpected channel ${channel}`);
  }
}

function addTask(id: string, extra: Partial<Task> = {}): void {
  setStore('tasks', id, {
    id,
    name: `Task ${id}`,
    projectId: 'proj',
    branchName: `task/${id}`,
    worktreePath: `/tmp/${id}`,
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
    baseBranch: 'main',
    ...extra,
  } as Task);
}

function spTask(id: string, extra: Partial<FakeSpTask> = {}): FakeSpTask {
  const task: FakeSpTask = {
    id,
    title: `SP ${id}`,
    isDone: false,
    projectId: null,
    parentId: null,
    notes: '',
    ...extra,
  };
  sp.tasks.set(id, task);
  return task;
}

const SETTLE_MS = 1_500;

describe('Super Productivity sync', () => {
  const [windowFocused, setWindowFocused] = createSignal(true);
  let stop: (() => void) | undefined;

  // eslint-disable-next-line solid/reactivity -- hands the accessor to the watcher, which tracks it
  beforeEach(async () => {
    vi.useFakeTimers();
    sp.tasks.clear();
    sp.current = null;
    sp.isBreak = false;
    sp.nextId = 1;
    sp.creates.length = 0;
    sp.projects = [{ id: 'sp-proj', title: 'Proj' }];
    mockShowNotification.mockReset();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (channel: string, args?: Record<string, unknown>) =>
      fakeSp(channel, args),
    );
    setWindowFocused(true);
    // Replace, not merge: `setStore('tasks', {})` would keep earlier tests' tasks.
    setStore(
      produce((s) => {
        s.tasks = {};
        s.terminals = {};
      }),
    );
    setStore('activeTaskId', null);
    setStore('projects', [
      {
        id: 'proj',
        name: 'Proj',
        path: '/repo',
        color: 'red',
        superProductivityProjectId: 'sp-proj',
      },
    ]);
    await refreshSpConnection();
    stop = startSuperProductivitySync(windowFocused);
  });

  afterEach(() => {
    stop?.();
    vi.useRealTimers();
  });

  /** Let the chain of IPC round trips a focus change starts run to completion. */
  async function settle(ms = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  async function focus(taskId: string | null): Promise<void> {
    setStore('activeTaskId', taskId);
    await settle(SETTLE_MS);
  }

  it('creates the task in the mapped project and tracks it once focus settles', async () => {
    addTask('a');
    setStore('activeTaskId', 'a');
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
    expect(sp.creates).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(sp.creates).toEqual([{ title: 'Task a', projectId: 'sp-proj' }]);
    expect(store.tasks.a.superProductivity).toEqual({ taskId: 'sp-1', syncedTitle: 'Task a' });
    expect(sp.current).toBe('sp-1');
  });

  it('only acts on the task focus rests on', async () => {
    addTask('a');
    addTask('b');
    setStore('activeTaskId', 'a');
    await vi.advanceTimersByTimeAsync(500);
    await focus('b');
    expect(sp.creates.map((c) => c.title)).toEqual(['Task b']);
  });

  it('switches between Parallel Code tasks and leaves tracking alone on a plain terminal', async () => {
    addTask('a');
    addTask('b');
    setStore('terminals', 'term', { id: 'term', name: 'Terminal 1', agentId: 'x' });
    await focus('a');
    await focus('b');
    expect(sp.current).toBe(store.tasks.b.superProductivity?.taskId);
    await focus('term');
    expect(sp.current).toBe(store.tasks.b.superProductivity?.taskId);
  });

  it('ignores focus changes while the window is in the background', async () => {
    addTask('a');
    setWindowFocused(false);
    await focus('a');
    expect(sp.creates).toHaveLength(0);
    expect(sp.current).toBeNull();
  });

  it('counts a click that reaches the renderer before the window focus event', async () => {
    addTask('a');
    setWindowFocused(false);
    setStore('activeTaskId', 'a');
    await vi.advanceTimersByTimeAsync(100);
    setWindowFocused(true);
    await settle(SETTLE_MS);
    expect(sp.current).toBe(store.tasks.a.superProductivity?.taskId);
  });

  it("leaves a document workspace's hidden agent task alone", async () => {
    addTask('doc-agent-proj');
    await focus('doc-agent-proj');
    expect(sp.creates).toHaveLength(0);
  });

  it('drops a mapping to a project that no longer exists there', async () => {
    sp.projects = [];
    addTask('a');
    await focus('a');
    expect(sp.creates).toEqual([{ title: 'Task a' }]);
  });

  it('never takes over a task tracked in Super Productivity that is not Parallel Code work', async () => {
    addTask('a');
    spTask('email', { title: 'Answer email' });
    sp.current = 'email';
    await focus('a');

    expect(sp.current).toBe('email');
    expect(sp.creates).toHaveLength(0);
    expect(spBanner()).toEqual({
      taskId: 'a',
      reason: 'other_task',
      trackingTitle: 'Answer email',
    });

    // The banner's button switches explicitly and clears it.
    expect(await trackTaskInSp('a')).toBe(true);
    expect(sp.current).toBe(store.tasks.a.superProductivity?.taskId);
    expect(spBanner()).toBeNull();
  });

  it('asks instead of starting during a break', async () => {
    addTask('a');
    sp.isBreak = true;
    await focus('a');
    expect(sp.current).toBeNull();
    expect(spBanner()?.reason).toBe('break');
  });

  it('asks before replacing a linked task that was archived or deleted there', async () => {
    addTask('a', { superProductivity: { taskId: 'gone', syncedTitle: 'Task a' } });
    await focus('a');
    expect(sp.creates).toHaveLength(0);
    expect(spBanner()).toEqual({ taskId: 'a', reason: 'missing', trackingTitle: undefined });

    expect(await trackTaskInSp('a')).toBe(true);
    expect(store.tasks.a.superProductivity?.taskId).toBe('sp-1');
    expect(sp.current).toBe('sp-1');
  });

  it('asks instead of reopening a linked task completed there', async () => {
    addTask('a', { superProductivity: { taskId: 'sp-a', syncedTitle: 'Task a' } });
    spTask('sp-a', { title: 'Task a', isDone: true });
    await focus('a');
    expect(sp.current).toBeNull();
    expect(spBanner()?.reason).toBe('done');
  });

  it('drops a banner when focus moves to another task', async () => {
    addTask('a');
    addTask('b');
    spTask('email');
    sp.current = 'email';
    await focus('a');
    expect(spBanner()?.taskId).toBe('a');
    setStore('activeTaskId', 'b');
    expect(spBanner()).toBeNull();
  });

  it('tracks the task once the conflict was resolved over there', async () => {
    addTask('a');
    spTask('email');
    sp.current = 'email';
    await focus('a');
    expect(spBanner()?.reason).toBe('other_task');

    setWindowFocused(false);
    await vi.advanceTimersByTimeAsync(0);
    sp.current = null; // the user stopped the other task in Super Productivity
    setWindowFocused(true);
    await settle();
    expect(sp.current).toBe(store.tasks.a.superProductivity?.taskId);
    expect(spBanner()).toBeNull();
  });

  it('creates an agent-spawned subtask under its parent task', async () => {
    addTask('parent', { superProductivity: { taskId: 'sp-parent', syncedTitle: 'Task parent' } });
    spTask('sp-parent', { title: 'Task parent' });
    addTask('child', { coordinatedBy: 'parent' });
    await focus('child');
    expect(sp.creates).toEqual([{ title: 'Task child', parentId: 'sp-parent' }]);
  });

  it('pulls a rename made in Super Productivity when the window regains focus', async () => {
    addTask('a', { superProductivity: { taskId: 'sp-a', syncedTitle: 'Task a' } });
    spTask('sp-a', { title: 'Renamed there' });
    setWindowFocused(false);
    await vi.advanceTimersByTimeAsync(0);
    setWindowFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.tasks.a.name).toBe('Renamed there');
    expect(store.tasks.a.superProductivity?.syncedTitle).toBe('Renamed there');
  });

  it('pushes a rename made in Parallel Code', async () => {
    addTask('a', { superProductivity: { taskId: 'sp-a', syncedTitle: 'Task a' } });
    spTask('sp-a', { title: 'Task a' });
    setStore('tasks', 'a', 'name', 'Renamed here');
    onTaskRenamed('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(sp.tasks.get('sp-a')?.title).toBe('Renamed here');
    expect(store.tasks.a.superProductivity?.syncedTitle).toBe('Renamed here');
  });

  it('completes the linked task only when an armed removal fires', async () => {
    addTask('a', {
      superProductivity: { taskId: 'sp-a', syncedTitle: 'Task a' },
      prUrl: 'https://github.com/o/r/pull/9',
    });
    spTask('sp-a');
    armSpCompletion('a', { kind: 'closed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sp.tasks.get('sp-a')?.isDone).toBe(false);

    fireSpCompletion('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(sp.tasks.get('sp-a')).toMatchObject({
      isDone: true,
      notes: 'Closed in Parallel Code (branch `task/a`). PR: https://github.com/o/r/pull/9',
    });
  });

  it('tells the user when completing fails because the app is unreachable', async () => {
    addTask('a', { superProductivity: { taskId: 'sp-a', syncedTitle: 'Task a' } });
    armSpCompletion('a', { kind: 'merged' });
    mockInvoke.mockImplementationOnce(async () => ({ ok: false, reason: 'unreachable' }));
    fireSpCompletion('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(mockShowNotification).toHaveBeenCalledWith(
      'Could not mark “Task a” done in Super Productivity',
    );
  });

  it('does not complete anything for a removal nobody armed', async () => {
    addTask('a', { superProductivity: { taskId: 'sp-a', syncedTitle: 'Task a' } });
    spTask('sp-a');
    fireSpCompletion('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(sp.tasks.get('sp-a')?.isDone).toBe(false);
  });
});
