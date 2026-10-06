import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { mockFireAndForget, mockInvoke, mockSaveState } = vi.hoisted(() => ({
  mockFireAndForget: vi.fn(),
  mockInvoke: vi.fn(),
  mockSaveState: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  fireAndForget: mockFireAndForget,
  invoke: mockInvoke,
}));

vi.mock('./persistence', () => ({
  saveState: mockSaveState,
}));

import { setStore, store } from './core';
import { getPrChecks, startPrChecksSubscription } from './pr-checks';

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const mockOn = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  setStore('taskOrder', []);
  setStore('collapsedTaskOrder', []);
  setStore('tasks', {});
  mockSaveState.mockResolvedValue(undefined);
  mockOn.mockReturnValue(vi.fn());
  vi.stubGlobal('window', {
    electron: {
      ipcRenderer: {
        on: mockOn,
      },
    },
    setInterval: vi.fn(() => 1),
  });
});

describe('startPrChecksSubscription updates', () => {
  it('stores draft and review-decision metadata from the watcher', () => {
    setStore('taskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task',
        projectId: 'project-1',
        branchName: 'task/task-1',
        worktreePath: '/repo/.worktrees/task-1',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        gitIsolation: 'worktree',
        prUrl: 'https://github.com/acme/app/pull/12',
      },
    });

    let disposeRoot: (() => void) | undefined;
    createRoot((dispose) => {
      disposeRoot = dispose;
      startPrChecksSubscription();
    });
    const updateHandler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC.PrChecksUpdate,
    )?.[1] as ((data: unknown) => void) | undefined;

    updateHandler?.({
      taskId: 'task-1',
      overall: 'success',
      passing: 2,
      pending: 0,
      failing: 0,
      checks: [],
      isDraft: false,
      reviewDecision: 'APPROVED',
      checkedAt: '2026-08-04T10:00:00.000Z',
      cleared: false,
    });

    expect(getPrChecks('task-1')).toMatchObject({
      isDraft: false,
      reviewDecision: 'APPROVED',
    });
    disposeRoot?.();
  });

  it('keeps a merged PR state after the watcher clears', () => {
    setStore('taskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task',
        projectId: 'project-1',
        branchName: 'task/task-1',
        worktreePath: '/repo/.worktrees/task-1',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        gitIsolation: 'worktree',
        prUrl: 'https://github.com/acme/app/pull/12',
      },
    });

    let disposeRoot: (() => void) | undefined;
    createRoot((dispose) => {
      disposeRoot = dispose;
      startPrChecksSubscription();
    });
    const updateHandler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC.PrChecksUpdate,
    )?.[1] as ((data: unknown) => void) | undefined;
    const cleared = {
      taskId: 'task-1',
      overall: 'none',
      passing: 0,
      pending: 0,
      failing: 0,
      checks: [],
      checkedAt: '2026-08-04T10:00:00.000Z',
      cleared: true,
    };

    updateHandler?.({ ...cleared, merged: true });
    expect(getPrChecks('task-1')).toMatchObject({ overall: 'none', merged: true });

    updateHandler?.({ ...cleared, merged: false });
    expect(getPrChecks('task-1')).toBeUndefined();

    // A later open PR on the same task must not inherit the merged flag.
    updateHandler?.({ ...cleared, merged: true });
    updateHandler?.({ ...cleared, overall: 'success', passing: 1, cleared: false });
    expect(getPrChecks('task-1')).toMatchObject({ overall: 'success', merged: false });
    disposeRoot?.();
  });
});

describe('startPrChecksSubscription branch PR detection', () => {
  it('persists a detected branch PR and starts watching it', async () => {
    setStore('taskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task',
        projectId: 'project-1',
        branchName: 'task/task-1',
        worktreePath: '/repo/.worktrees/task-1',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        gitIsolation: 'worktree',
      },
    });
    mockInvoke.mockResolvedValueOnce({ url: 'https://github.com/acme/app/pull/12' });

    let disposeRoot: (() => void) | undefined;
    createRoot((dispose) => {
      disposeRoot = dispose;
      startPrChecksSubscription();
    });
    await flushPromises();
    await flushPromises();

    expect(mockInvoke).toHaveBeenCalledWith(IPC.DetectPrForBranch, {
      worktreePath: '/repo/.worktrees/task-1',
      branchName: 'task/task-1',
    });
    expect(store.tasks['task-1'].prUrl).toBe('https://github.com/acme/app/pull/12');
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    expect(mockFireAndForget).toHaveBeenCalledWith(IPC.StartPrChecksWatcher, {
      taskId: 'task-1',
      prUrl: 'https://github.com/acme/app/pull/12',
      taskName: 'Task',
    });
    disposeRoot?.();
  });

  it('does not keep probing branches after gh is unavailable', async () => {
    setStore('taskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task',
        projectId: 'project-1',
        branchName: 'task/task-1',
        worktreePath: '/repo/.worktrees/task-1',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        gitIsolation: 'worktree',
      },
    });
    mockInvoke.mockResolvedValueOnce({ url: null, unavailable: 'missing' });

    let disposeRoot: (() => void) | undefined;
    createRoot((dispose) => {
      disposeRoot = dispose;
      startPrChecksSubscription();
    });
    await flushPromises();

    setStore('taskOrder', ['task-1', 'task-2']);
    setStore('tasks', 'task-2', {
      id: 'task-2',
      name: 'Task 2',
      projectId: 'project-1',
      branchName: 'task/task-2',
      worktreePath: '/repo/.worktrees/task-2',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
    });
    await flushPromises();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(store.tasks['task-1'].prUrl).toBeUndefined();
    expect(store.tasks['task-2'].prUrl).toBeUndefined();
    disposeRoot?.();
  });

  it('limits concurrent branch probes and probes the rest as slots free up', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `task-${i}`);
    setStore('taskOrder', ids);
    setStore(
      'tasks',
      Object.fromEntries(
        ids.map((id) => [
          id,
          {
            id,
            name: id,
            projectId: 'project-1',
            branchName: `task/${id}`,
            worktreePath: `/repo/.worktrees/${id}`,
            agentIds: [],
            shellAgentIds: [],
            notes: '',
            lastPrompt: '',
            gitIsolation: 'worktree' as const,
          },
        ]),
      ),
    );
    const pending: Array<(value: { url: null }) => void> = [];
    mockInvoke.mockImplementation(
      () => new Promise<{ url: null }>((resolve) => pending.push(resolve)),
    );
    const probedPaths = () =>
      mockInvoke.mock.calls
        .filter(([channel]) => channel === IPC.DetectPrForBranch)
        .map(([, args]) => (args as { worktreePath: string }).worktreePath);

    let disposeRoot: (() => void) | undefined;
    createRoot((dispose) => {
      disposeRoot = dispose;
      startPrChecksSubscription();
    });
    await flushPromises();
    expect(probedPaths()).toHaveLength(4);

    pending.shift()?.({ url: null });
    await flushPromises();
    expect(probedPaths()).toHaveLength(5);

    while (pending.length > 0) {
      pending.shift()?.({ url: null });
      await flushPromises();
    }
    expect([...probedPaths()].sort()).toEqual(ids.map((id) => `/repo/.worktrees/${id}`).sort());
    disposeRoot?.();
  });
});
