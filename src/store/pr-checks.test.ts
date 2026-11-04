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
import { getMergedTasksTodayCount } from './completion';
import { getPrChecks, startPrChecksSubscription } from './pr-checks';
import {
  extraPrWatchId,
  getTaskExtraPrs,
  removePrChecks,
  setTaskExtraPrs,
} from './pr-checks-state';

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const mockOn = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  setStore({ completedTaskCount: 0, countedMergedPrs: [] });
  setStore('taskOrder', []);
  setStore('collapsedTaskOrder', []);
  setStore('tasks', {});
  mockSaveState.mockResolvedValue(undefined);
  // Tasks are probed for further PRs even when they already have one.
  mockInvoke.mockResolvedValue({ url: null });
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
      watchId: 'task-1',
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
      watchId: 'task-1',
      overall: 'none',
      passing: 0,
      pending: 0,
      failing: 0,
      checks: [],
      checkedAt: '2026-08-04T10:00:00.000Z',
      cleared: true,
    };

    const merge = {
      ...cleared,
      merged: true,
      prUrl: 'https://github.com/acme/app/pull/12',
      mergedAt: new Date().toISOString(),
    };
    updateHandler?.(merge);
    updateHandler?.(merge);
    expect(getMergedTasksTodayCount()).toBe(1);
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    expect(getPrChecks('task-1')).toMatchObject({ overall: 'none', merged: true });

    updateHandler?.({ ...cleared, merged: false });
    expect(getPrChecks('task-1')).toBeUndefined();

    // A later open PR on the same task must not inherit the merged flag.
    updateHandler?.({ ...cleared, merged: true });
    updateHandler?.({ ...cleared, overall: 'success', passing: 1, cleared: false });
    expect(getPrChecks('task-1')).toMatchObject({ overall: 'success', merged: false });
    disposeRoot?.();
  });

  it('stops babysitting a PR that closes without merging', () => {
    const prUrl = 'https://github.com/acme/app/pull/12';
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
        prUrl,
        prBabysit: { attempts: 1, lastSentSha: 'abc' },
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
      watchId: 'task-1',
      prUrl,
      overall: 'none',
      passing: 0,
      pending: 0,
      failing: 0,
      checks: [],
      checkedAt: '2026-08-04T10:00:00.000Z',
      cleared: true,
      merged: false,
    });

    // The Babysit button hides with the PR, so nothing else could turn it off.
    expect(store.tasks['task-1']?.prBabysit).toBeUndefined();
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
      watchId: 'task-1',
      prUrl: 'https://github.com/acme/app/pull/12',
      taskName: 'Task',
      babysit: false,
      branch: { worktreePath: '/repo/.worktrees/task-1', branchName: 'task/task-1' },
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

describe('startPrChecksSubscription additional PRs', () => {
  const primaryUrl = 'https://github.com/acme/app/pull/12';
  const apiUrl = 'https://github.com/acme/api/pull/7';
  const apiWatchId = extraPrWatchId('task-1', apiUrl);

  // Both stores are module state and outlive a disposed subscription.
  beforeEach(() => {
    setTaskExtraPrs('task-1', []);
    removePrChecks('task-1');
    removePrChecks(apiWatchId);
  });

  function setupTaskWithExtraPr(): { dispose: () => void; update: (data: unknown) => void } {
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
        prUrl: primaryUrl,
      },
    });
    mockInvoke.mockResolvedValueOnce({
      url: primaryUrl,
      extras: [{ url: apiUrl, repo: 'api' }],
    });
    let dispose = (): void => {};
    createRoot((d) => {
      dispose = d;
      startPrChecksSubscription();
    });
    const update = mockOn.mock.calls.find(([channel]) => channel === IPC.PrChecksUpdate)?.[1] as (
      data: unknown,
    ) => void;
    return { dispose, update };
  }

  // Runs the periodic scan after the retry window, so the task is probed again.
  let rescans = 0;
  async function rescan(result: unknown): Promise<void> {
    mockInvoke.mockResolvedValueOnce(result);
    const scanTimer = vi.mocked(window.setInterval).mock.calls[0]?.[0] as () => void;
    rescans += 1;
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + rescans * 10 * 60_000);
    try {
      scanTimer();
      await flushPromises();
      await flushPromises();
    } finally {
      now.mockRestore();
    }
  }

  const stopApiWatcher = { watchId: apiWatchId };

  it('does not list the primary PR again when the task links it decorated', async () => {
    const { dispose } = setupTaskWithExtraPr();
    await flushPromises();
    await flushPromises();
    setStore('tasks', 'task-1', 'prUrl', `${primaryUrl}/files`);

    await rescan({ url: primaryUrl, extras: [{ url: apiUrl, repo: 'api' }] });

    expect(getTaskExtraPrs('task-1')).toEqual([{ url: apiUrl, repo: 'api' }]);
    dispose();
  });

  it('watches PRs of nested repositories beside the primary PR', async () => {
    const { dispose } = setupTaskWithExtraPr();
    await flushPromises();
    await flushPromises();

    expect(getTaskExtraPrs('task-1')).toEqual([{ url: apiUrl, repo: 'api' }]);
    expect(mockFireAndForget).toHaveBeenCalledWith(IPC.StartPrChecksWatcher, {
      taskId: 'task-1',
      watchId: 'task-1',
      prUrl: primaryUrl,
      taskName: 'Task',
      babysit: false,
      branch: { worktreePath: '/repo/.worktrees/task-1', branchName: 'task/task-1' },
    });
    expect(mockFireAndForget).toHaveBeenCalledWith(IPC.StartPrChecksWatcher, {
      taskId: 'task-1',
      watchId: apiWatchId,
      prUrl: apiUrl,
      taskName: 'Task · api #7',
      babysit: false,
      branch: null,
    });
    dispose();
  });

  it('stores an additional PR’s checks apart from the primary PR', async () => {
    const { dispose, update } = setupTaskWithExtraPr();
    await flushPromises();
    await flushPromises();

    update({
      taskId: 'task-1',
      watchId: 'task-1',
      prUrl: primaryUrl,
      overall: 'success',
      passing: 3,
      pending: 0,
      failing: 0,
      checks: [],
      checkedAt: '2026-10-22T10:00:00.000Z',
      cleared: false,
    });
    update({
      taskId: 'task-1',
      watchId: apiWatchId,
      prUrl: apiUrl,
      overall: 'failure',
      passing: 1,
      pending: 0,
      failing: 1,
      checks: [],
      checkedAt: '2026-10-22T10:00:00.000Z',
      cleared: false,
    });

    expect(getPrChecks(apiWatchId)).toMatchObject({ overall: 'failure', failing: 1 });
    expect(getPrChecks('task-1')).toMatchObject({ overall: 'success', passing: 3 });
    dispose();
  });

  it('stops watching an additional PR once it is no longer open', async () => {
    const { dispose } = setupTaskWithExtraPr();
    await flushPromises();
    await flushPromises();
    await rescan({ url: primaryUrl, extras: [] });

    expect(getTaskExtraPrs('task-1')).toEqual([]);
    expect(mockFireAndForget).toHaveBeenCalledWith(IPC.StopPrChecksWatcher, stopApiWatcher);
    expect(mockFireAndForget).not.toHaveBeenCalledWith(IPC.StopPrChecksWatcher, {
      watchId: 'task-1',
    });
    dispose();
  });

  it('keeps a merged additional PR after it drops out of the open PRs', async () => {
    const { dispose, update } = setupTaskWithExtraPr();
    await flushPromises();
    await flushPromises();
    update({
      taskId: 'task-1',
      watchId: apiWatchId,
      prUrl: apiUrl,
      overall: 'none',
      cleared: true,
      merged: true,
      mergedAt: '2026-10-22T10:00:00.000Z',
    });

    await rescan({ url: primaryUrl, extras: [] });

    expect(getTaskExtraPrs('task-1')).toEqual([{ url: apiUrl, repo: 'api' }]);
    expect(getPrChecks(apiWatchId)).toMatchObject({ merged: true });
    expect(mockFireAndForget).not.toHaveBeenCalledWith(IPC.StopPrChecksWatcher, stopApiWatcher);
    dispose();
  });

  it('keeps additional PRs when a probe could not list them', async () => {
    const { dispose } = setupTaskWithExtraPr();
    await flushPromises();
    await flushPromises();

    await rescan({ url: primaryUrl });

    expect(getTaskExtraPrs('task-1')).toEqual([{ url: apiUrl, repo: 'api' }]);
    expect(mockFireAndForget).not.toHaveBeenCalledWith(IPC.StopPrChecksWatcher, stopApiWatcher);
    dispose();
  });

  it('ignores a late update for an additional PR it stopped watching', async () => {
    const { dispose, update } = setupTaskWithExtraPr();
    await flushPromises();
    await flushPromises();
    await rescan({ url: primaryUrl, extras: [] });

    update({
      taskId: 'task-1',
      watchId: apiWatchId,
      prUrl: apiUrl,
      overall: 'failure',
      failing: 1,
      cleared: false,
    });

    expect(getPrChecks(apiWatchId)).toBeUndefined();
    dispose();
  });

  it('drops a closed additional PR at once instead of watching it again', async () => {
    const { dispose, update } = setupTaskWithExtraPr();
    await flushPromises();
    await flushPromises();
    update({
      taskId: 'task-1',
      watchId: apiWatchId,
      prUrl: apiUrl,
      overall: 'none',
      cleared: true,
      merged: false,
    });
    expect(getTaskExtraPrs('task-1')).toEqual([]);
    mockFireAndForget.mockClear();

    // A probe that could not list extras re-syncs watchers without changing the list.
    await rescan({ url: primaryUrl });

    expect(mockFireAndForget).not.toHaveBeenCalledWith(
      IPC.StartPrChecksWatcher,
      expect.objectContaining({ watchId: apiWatchId }),
    );
    dispose();
  });

  it('keeps the PRs of a repository whose probe failed', async () => {
    const webUrl = 'https://github.com/acme/web/pull/8';
    const { dispose } = setupTaskWithExtraPr();
    await flushPromises();
    await flushPromises();

    await rescan({ url: primaryUrl, extras: [{ url: webUrl, repo: 'web' }], failedRepos: ['api'] });

    expect(getTaskExtraPrs('task-1')).toEqual([
      { url: apiUrl, repo: 'api' },
      { url: webUrl, repo: 'web' },
    ]);
    expect(mockFireAndForget).not.toHaveBeenCalledWith(IPC.StopPrChecksWatcher, stopApiWatcher);
    dispose();
  });

  it('stops polling a closed primary PR and adopts the next open PR of the branch', async () => {
    const nextUrl = 'https://github.com/acme/app/pull/13';
    const { dispose, update } = setupTaskWithExtraPr();
    await flushPromises();
    await flushPromises();
    update({
      taskId: 'task-1',
      watchId: 'task-1',
      prUrl: primaryUrl,
      overall: 'none',
      cleared: true,
      merged: false,
    });
    mockFireAndForget.mockClear();

    await rescan({ url: null, extras: [] });
    expect(mockFireAndForget).not.toHaveBeenCalledWith(
      IPC.StartPrChecksWatcher,
      expect.objectContaining({ watchId: 'task-1' }),
    );

    await rescan({ url: nextUrl, extras: [] });
    expect(store.tasks['task-1']?.prUrl).toBe(nextUrl);
    expect(mockFireAndForget).toHaveBeenCalledWith(IPC.StartPrChecksWatcher, {
      taskId: 'task-1',
      watchId: 'task-1',
      prUrl: nextUrl,
      taskName: 'Task',
      babysit: false,
      branch: { worktreePath: '/repo/.worktrees/task-1', branchName: 'task/task-1' },
    });
    dispose();
  });

  it('watches a closed primary PR again once it is reopened', async () => {
    const { dispose, update } = setupTaskWithExtraPr();
    await flushPromises();
    await flushPromises();
    update({
      taskId: 'task-1',
      watchId: 'task-1',
      prUrl: primaryUrl,
      overall: 'none',
      cleared: true,
      merged: false,
    });
    mockFireAndForget.mockClear();

    await rescan({ url: primaryUrl, extras: [] });

    expect(mockFireAndForget).toHaveBeenCalledWith(
      IPC.StartPrChecksWatcher,
      expect.objectContaining({ watchId: 'task-1', prUrl: primaryUrl }),
    );
    dispose();
  });

  it('shows an additional PR as merged when a probe notices before its watcher', async () => {
    const { dispose } = setupTaskWithExtraPr();
    await flushPromises();
    await flushPromises();
    mockInvoke.mockImplementation((channel: string) =>
      Promise.resolve(channel === IPC.GetPullRequestDetails ? { state: 'MERGED' } : { url: null }),
    );
    mockFireAndForget.mockClear();

    await rescan({ url: primaryUrl, extras: [] });

    expect(mockInvoke).toHaveBeenCalledWith(IPC.GetPullRequestDetails, { prUrl: apiUrl });
    expect(getTaskExtraPrs('task-1')).toEqual([{ url: apiUrl, repo: 'api' }]);
    expect(getPrChecks(apiWatchId)).toMatchObject({ merged: true });
    // Listed until GitHub answers, so the chip and its watcher never drop out.
    expect(mockFireAndForget).not.toHaveBeenCalledWith(IPC.StopPrChecksWatcher, stopApiWatcher);
    dispose();
  });
});
