import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { fireAndForget } from '../lib/ipc';
import { applyAgentHookEvent } from './agentHookStatus';
import { setStore } from './core';
import {
  extraPrWatchId,
  getTaskExtraPrs,
  markPrimaryPrClosed,
  removePrChecks,
  setPrChecks,
  setTaskExtraPrs,
  type PrChecksState,
} from './pr-checks-state';
import { startRemoteStatusSync } from './remoteStatusSync';
import { clearAgentActivity, markAgentOutput } from './taskStatus';

vi.mock('../lib/ipc', () => ({ fireAndForget: vi.fn(), invoke: vi.fn() }));

let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setStore(
    'tasks',
    reconcile({
      task: {
        id: 'task',
        name: 'Task',
        projectId: 'project',
        branchName: 'task/test',
        worktreePath: '/tmp/task',
        agentIds: ['agent', 'other'],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        gitIsolation: 'worktree',
      },
    }),
  );
  setStore('agents', reconcile({}));
  for (const id of ['agent', 'other']) {
    setStore('agents', id, {
      id,
      taskId: 'task',
      def: {
        id: 'claude',
        name: 'Claude',
        command: 'claude',
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: '',
      },
      resumed: false,
      status: 'running',
      exitCode: null,
      signal: null,
      lastOutput: [],
      generation: 0,
    });
  }
  setStore('taskOrder', ['task']);
  setStore('collapsedTaskOrder', []);
  setStore('activeTaskId', null);
  setStore('remoteAccess', 'enabled', true);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  clearAgentActivity('agent');
  clearAgentActivity('other');
  removePrChecks('task');
  for (const pr of getTaskExtraPrs('task')) removePrChecks(extraPrWatchId('task', pr.url));
  setTaskExtraPrs('task', []);
  markPrimaryPrClosed('task', undefined);
  setStore('projects', []);
  vi.useRealTimers();
});

function expectAttention(attention: string): void {
  expect(fireAndForget).toHaveBeenLastCalledWith(
    IPC.Remote_UpdateTaskStatus,
    expect.objectContaining({ statuses: { task: attention } }),
  );
}

it.each(['active', 'review', 'error'] as const)(
  'publishes waiting hooks immediately over %s and restores it after the answer',
  (attention) => {
    applyAgentHookEvent({
      agentId: 'agent',
      taskId: 'task',
      state: 'working',
      event: 'UserPromptSubmit',
      at: Date.now(),
    });
    if (attention === 'review') setStore('tasks', 'task', 'needsReview', true);
    if (attention === 'error') setStore('agents', 'other', { status: 'exited', exitCode: 1 });
    stop = startRemoteStatusSync();
    expectAttention(attention);

    applyAgentHookEvent({
      agentId: 'agent',
      taskId: 'task',
      state: 'waiting',
      event: 'PermissionRequest',
      at: Date.now(),
    });
    expectAttention('needs_input');

    applyAgentHookEvent({
      agentId: 'agent',
      taskId: 'task',
      state: 'working',
      event: 'PostToolUse',
      at: Date.now(),
    });
    expectAttention(attention);
  },
);

it('syncs an existing terminal question in a collapsed review task when phone access starts', () => {
  setStore('tasks', 'task', { needsReview: true, collapsed: true });
  setStore('taskOrder', []);
  setStore('collapsedTaskOrder', ['task']);
  setStore('remoteAccess', 'enabled', false);
  markAgentOutput('agent', new TextEncoder().encode('Continue? [Y/n]'), 'task');
  stop = startRemoteStatusSync();
  expect(fireAndForget).not.toHaveBeenCalled();

  setStore('remoteAccess', 'enabled', true);
  expectAttention('needs_input');

  markAgentOutput('agent', new TextEncoder().encode('\r\n❯\r\n'), 'task');
  expectAttention('review');
});

it('tells the phone which tasks wait to be resumed', () => {
  const suspended = () => {
    const [, payload] = vi.mocked(fireAndForget).mock.lastCall ?? [];
    return (payload as { contexts: Record<string, { suspended?: unknown }> }).contexts.task
      .suspended;
  };
  stop = startRemoteStatusSync();
  expect(suspended()).toBe(false);

  for (const id of ['agent', 'other']) {
    setStore('agents', id, { status: 'exited', signal: 'suspended' });
  }
  expect(suspended()).toBe(true);
  expectAttention('idle');

  // One resumed agent is enough for the task to have a process again.
  setStore('agents', 'other', { status: 'running', signal: null });
  expect(suspended()).toBe(false);
});

function lastCi(): unknown {
  const [, payload] = vi.mocked(fireAndForget).mock.lastCall ?? [];
  return (payload as { contexts: Record<string, { ci?: unknown }> }).contexts.task.ci;
}

it('publishes the PR check status, and drops it once the PR merges or has no checks', () => {
  const checks: PrChecksState = {
    overall: 'failure',
    passing: 1,
    pending: 0,
    failing: 1,
    checks: [],
    checkedAt: '2026-10-10T00:00:00Z',
  };
  setStore('tasks', 'task', 'prUrl', 'https://github.com/o/r/pull/1');
  stop = startRemoteStatusSync();
  expect(lastCi()).toBeUndefined();

  setPrChecks('task', checks);
  expect(lastCi()).toBe('failure');

  const green = {
    ...checks,
    overall: 'success' as const,
    failing: 0,
    mergeable: 'MERGEABLE' as const,
  };
  setPrChecks('task', { ...green, mergeStateStatus: 'CLEAN' });
  expect(lastCi()).toBe('success');

  // The phone reads success as "Ready to merge", which a branch behind its base is not.
  setPrChecks('task', { ...green, mergeStateStatus: 'BEHIND' });
  expect(lastCi()).toBeUndefined();

  setPrChecks('task', { ...checks, overall: 'none' });
  expect(lastCi()).toBeUndefined();

  setPrChecks('task', { ...checks, overall: 'success', merged: true });
  expect(lastCi()).toBeUndefined();
});

it('publishes the board lane so the phone groups tasks like the desktop board', () => {
  const lastLane = () => {
    const [, payload] = vi.mocked(fireAndForget).mock.lastCall ?? [];
    return (payload as { contexts: Record<string, { lane?: unknown }> }).contexts.task.lane;
  };
  stop = startRemoteStatusSync();
  expect(lastLane()).toBe('stopped');

  setStore('tasks', 'task', 'prUrl', 'https://github.com/o/r/pull/1');
  expect(lastLane()).toBe('pr');

  setStore('tasks', 'task', 'collapsed', true);
  expect(lastLane()).toBe('snoozed');
});

it('publishes the PR row of the PR that most needs attention', () => {
  const lastPr = () => {
    const [, payload] = vi.mocked(fireAndForget).mock.lastCall ?? [];
    return (payload as { contexts: Record<string, { pr?: unknown }> }).contexts.task.pr;
  };
  const extra = 'https://github.com/o/lib/pull/3';
  setStore('tasks', 'task', 'prUrl', 'https://github.com/o/r/pull/1');
  setPrChecks('task', {
    overall: 'none',
    merged: true,
    passing: 0,
    pending: 0,
    failing: 0,
    checks: [],
    checkedAt: '2026-10-10T00:00:00Z',
  });
  setTaskExtraPrs('task', [{ url: extra, repo: 'lib' }]);
  setPrChecks(extraPrWatchId('task', extra), {
    overall: 'failure',
    passing: 0,
    pending: 0,
    failing: 1,
    checks: [],
    checkedAt: '2026-10-10T00:00:00Z',
  });
  stop = startRemoteStatusSync();
  expect(lastPr()).toEqual({ url: extra, label: 'CI failed', kind: 'failed' });
});

it('still links its own PR once that closed unmerged, without a status', () => {
  const url = 'https://github.com/o/r/pull/1';
  setStore('tasks', 'task', 'prUrl', url);
  // Babysit can outlive the PR while another repository's PRs cannot be listed.
  setStore('tasks', 'task', 'prBabysit', { attempts: 0 });
  markPrimaryPrClosed('task', url);
  stop = startRemoteStatusSync();
  const [, payload] = vi.mocked(fireAndForget).mock.lastCall ?? [];
  expect((payload as { contexts: Record<string, { pr?: unknown }> }).contexts.task.pr).toEqual({
    url,
  });
});

it('publishes the PR row and project icon the board card shows', () => {
  const lastContext = () => {
    const [, payload] = vi.mocked(fireAndForget).mock.lastCall ?? [];
    return (payload as { contexts: Record<string, { pr?: unknown; projectIcon?: unknown }> })
      .contexts.task;
  };
  setStore('projects', [
    { id: 'project', name: 'App', path: '/tmp', color: '#fff', icon: 'rocket' },
  ]);
  stop = startRemoteStatusSync();
  expect(lastContext().projectIcon).toBe('rocket');
  expect(lastContext().pr).toBeUndefined();

  const url = 'https://github.com/o/r/pull/1';
  setStore('tasks', 'task', 'prUrl', url);
  expect(lastContext().pr).toEqual({ url });

  setPrChecks('task', {
    overall: 'failure',
    passing: 0,
    pending: 0,
    failing: 1,
    checks: [],
    checkedAt: '2026-10-10T00:00:00Z',
  });
  setStore('tasks', 'task', 'prBabysit', { attempts: 0 });
  expect(lastContext().pr).toEqual({ url, label: 'CI failed', kind: 'failed', babysit: true });
});
