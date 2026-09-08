import { describe, it, expect, vi, afterEach } from 'vitest';

// Uses the REAL solid store (unlike taskStatus.test.ts, whose mock harness
// historically REPLACED objects on setStore). Solid's setStore MERGES objects
// at a path, so snapshot flags omitted from a later write survive it — the
// exact behavior the flag-lifecycle regressions cover.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/ipc', () => ({ invoke: invokeMock }));
vi.mock('../lib/log', async (importOriginal) => ({
  // Keep the real errMessage; only silence the log channels.
  ...(await importOriginal<typeof import('../lib/log')>()),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { store, setStore } from './core';
import {
  refreshTaskStatus,
  refreshAllTaskGitStatus,
  clearTaskGitStatusTracking,
  getBranchDivergence,
} from './taskStatus';
import { undoBranchAdoption } from './task-branch';
import type { Task, TaskGitStatusSnapshot } from './types';
import type { WorktreeStatus } from '../ipc/types';

const seededTaskIds: string[] = [];

/** Seed a worktree task and register it for afterEach cleanup. */
function seedTask(taskId: string): void {
  seededTaskIds.push(taskId);
  const task: Task = {
    id: taskId,
    name: taskId,
    projectId: 'project-1',
    branchName: `task/${taskId}`,
    worktreePath: `/tmp/worktrees/${taskId}`,
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
    baseBranch: 'main',
  };
  setStore('tasks', taskId, task);
}

function worktreeStatus(currentBranch: string): WorktreeStatus {
  return {
    has_committed_changes: true,
    has_uncommitted_changes: false,
    current_branch: currentBranch,
    base_branch: 'main',
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 2));

/** Two refreshes with a Date.now() gap — enough for the two-snapshot debounce. */
async function refreshTwice(taskId: string): Promise<void> {
  refreshTaskStatus(taskId);
  await flush();
  await flush();
  refreshTaskStatus(taskId);
  await flush();
}

afterEach(() => {
  invokeMock.mockReset();
  const ids = seededTaskIds.splice(0);
  setStore('taskOrder', (order) => order.filter((id) => !ids.includes(id)));
  for (const taskId of ids) {
    clearTaskGitStatusTracking(taskId);
    setStore('tasks', taskId, undefined as unknown as Task);
    setStore('taskGitStatus', taskId, undefined as unknown as TaskGitStatusSnapshot);
  }
});

describe('refreshTaskStatus snapshot flag lifecycle', () => {
  it('clears error, refreshing and stale flags on a successful refresh', async () => {
    seedTask('t-flags');
    // Poisoned snapshot: one failed refresh (error), a 5-minute polling gap
    // (stale) and a pending invalidateExisting pass (refreshing) all merged in.
    setStore('taskGitStatus', 't-flags', {
      has_committed_changes: false,
      has_uncommitted_changes: false,
      current_branch: 'task/t-flags',
      base_branch: 'main',
      refreshedAt: 1_000,
      error: 'boom',
      stale: true,
      refreshing: true,
    });
    invokeMock.mockResolvedValue(worktreeStatus('task/t-flags'));

    refreshTaskStatus('t-flags');
    await flush();

    const snapshot = store.taskGitStatus['t-flags'];
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.refreshing).toBe(false);
    expect(snapshot.stale).toBe(false);
    expect(snapshot.current_branch).toBe('task/t-flags');
    expect(snapshot.refreshedAt).toBeGreaterThan(1_000);
  });

  it('adopts the switched branch again after the snapshot went stale', async () => {
    seedTask('t-stale');
    // A background task not polled for 5 minutes gets stale merged into its
    // snapshot. The plain background poll (no invalidateExisting, so nothing
    // clears the flag explicitly) must still recover divergence detection.
    setStore('taskOrder', [...store.taskOrder, 't-stale']);
    setStore('taskGitStatus', 't-stale', {
      has_committed_changes: false,
      has_uncommitted_changes: false,
      current_branch: 'task/t-stale',
      base_branch: 'main',
      refreshedAt: 1_000,
      stale: true,
    });
    invokeMock.mockResolvedValue(worktreeStatus('fix/issue-42'));

    await refreshAllTaskGitStatus();
    // Two-snapshot debounce: the first sighting alone must not adopt.
    expect(store.tasks['t-stale'].branchName).toBe('task/t-stale');

    await flush(); // separate Date.now() timestamps for the two snapshots
    await refreshAllTaskGitStatus();

    expect(store.tasks['t-stale'].branchName).toBe('fix/issue-42');
    expect(store.tasks['t-stale'].branchAdoptedFrom).toBe('task/t-stale');
  });

  it('adopts the switched branch again after a transient refresh error', async () => {
    seedTask('t-error');
    invokeMock.mockRejectedValueOnce(new Error('index.lock held'));
    refreshTaskStatus('t-error');
    await flush();
    expect(store.taskGitStatus['t-error'].error).toBe('index.lock held');

    invokeMock.mockResolvedValue(worktreeStatus('fix/issue-7'));
    await refreshTwice('t-error');

    expect(store.taskGitStatus['t-error'].error).toBeUndefined();
    expect(store.tasks['t-error'].branchName).toBe('fix/issue-7');
    expect(store.tasks['t-error'].branchAdoptedFrom).toBe('task/t-error');
  });
});

describe('branch auto-adoption', () => {
  it('adopts a confirmed divergent branch and clears the divergence', async () => {
    seedTask('t-adopt');
    invokeMock.mockResolvedValue(worktreeStatus('feature/agent-picked'));

    await refreshTwice('t-adopt');

    expect(store.tasks['t-adopt'].branchName).toBe('feature/agent-picked');
    expect(store.tasks['t-adopt'].branchAdoptedFrom).toBe('task/t-adopt');
    // Task now tracks the worktree branch, so nothing diverges anymore.
    expect(getBranchDivergence('t-adopt')).toBeNull();
  });

  it('does not adopt on a single sighting (transient checkouts)', async () => {
    seedTask('t-single');
    invokeMock.mockResolvedValue(worktreeStatus('feature/transient'));

    refreshTaskStatus('t-single');
    await flush();

    expect(store.tasks['t-single'].branchName).toBe('task/t-single');
    expect(store.tasks['t-single'].branchAdoptedFrom).toBeUndefined();
  });

  it('does not adopt the base branch, but keeps the divergence visible', async () => {
    seedTask('t-base');
    invokeMock.mockResolvedValue(worktreeStatus('main'));

    await refreshTwice('t-base');

    expect(store.tasks['t-base'].branchName).toBe('task/t-base');
    expect(store.tasks['t-base'].branchAdoptedFrom).toBeUndefined();
    expect(getBranchDivergence('t-base')).toEqual({
      kind: 'switched',
      branch: 'main',
      adoptable: false,
    });
  });

  it('undo restores the previous branch and blocks re-adoption', async () => {
    seedTask('t-undo');
    invokeMock.mockResolvedValue(worktreeStatus('feature/unwanted'));
    await refreshTwice('t-undo');
    expect(store.tasks['t-undo'].branchName).toBe('feature/unwanted');

    undoBranchAdoption('t-undo');

    expect(store.tasks['t-undo'].branchName).toBe('task/t-undo');
    expect(store.tasks['t-undo'].branchAdoptedFrom).toBeUndefined();
    expect(store.tasks['t-undo'].branchOfferDismissed).toBe('feature/unwanted');

    // The worktree is still on the unwanted branch — further polls must not
    // adopt it again.
    await refreshTwice('t-undo');
    expect(store.tasks['t-undo'].branchName).toBe('task/t-undo');
    expect(store.tasks['t-undo'].branchAdoptedFrom).toBeUndefined();
  });

  it('does not adopt a branch name the IPC layer would reject', async () => {
    seedTask('t-invalid');
    // git itself allows ';' in refnames, but every branch-parameterized IPC
    // call (merge, diff, close) would refuse it — adopting would wedge the task.
    invokeMock.mockResolvedValue(worktreeStatus('feature/pwn;x'));

    await refreshTwice('t-invalid');

    expect(store.tasks['t-invalid'].branchName).toBe('task/t-invalid');
    expect(store.tasks['t-invalid'].branchAdoptedFrom).toBeUndefined();
    expect(getBranchDivergence('t-invalid')).toEqual({
      kind: 'switched',
      branch: 'feature/pwn;x',
      adoptable: false,
    });
  });

  it('does not adopt while the task is closing', async () => {
    seedTask('t-closing');
    setStore('tasks', 't-closing', 'closingStatus', 'closing');
    invokeMock.mockResolvedValue(worktreeStatus('feature/too-late'));

    await refreshTwice('t-closing');

    expect(store.tasks['t-closing'].branchName).toBe('task/t-closing');
    expect(store.tasks['t-closing'].branchAdoptedFrom).toBeUndefined();
  });
});
