import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { fireAndForget } from '../lib/ipc';
import { applyAgentHookEvent } from './agentHookStatus';
import { setStore } from './core';
import { removePrChecks, setPrChecks, type PrChecksState } from './pr-checks-state';
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
  stop = startRemoteStatusSync();
  expect(lastCi()).toBeUndefined();

  setPrChecks('task', checks);
  expect(lastCi()).toBe('failure');

  setPrChecks('task', { ...checks, overall: 'success', failing: 0 });
  expect(lastCi()).toBe('success');

  setPrChecks('task', { ...checks, overall: 'none' });
  expect(lastCi()).toBeUndefined();

  setPrChecks('task', { ...checks, overall: 'success', merged: true });
  expect(lastCi()).toBeUndefined();
});
