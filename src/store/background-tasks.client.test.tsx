import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { TaskTitleBar } from '../components/TaskTitleBar';
import { store, setStore } from './core';
import { AGENT_HOOK_STALE_MS, applyAgentHookEvent, getAgentHookStatus } from './agentHookStatus';
import { clearAgentActivity, getTaskAttentionState, markAgentBusy } from './taskStatus';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { collapseTask, uncollapseTask } from './tasks';
import { setActiveTask } from './navigation';
import { removePrChecks, setPrChecks, type PrChecksState } from './pr-checks-state';
import { computeAttentionEntries } from './sidebar-attention';
import {
  bringTaskToFront,
  getTaskSnoozedUntil,
  isTaskBackgrounded,
  sendTaskToBack,
  snoozeTask,
  startBackgroundTaskWatcher,
} from './background-tasks';
import type { Task } from './types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));

function task(id: string): Task {
  return {
    id,
    name: id,
    projectId: 'project',
    branchName: id,
    worktreePath: `/tmp/${id}`,
    agentIds: [`${id}-agent`],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
  };
}

function hook(state: 'working' | 'waiting' | 'done', event: string, taskId = 'one') {
  applyAgentHookEvent({ agentId: `${taskId}-agent`, taskId, state, event, at: Date.now() });
}

let stop: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockClear().mockResolvedValue(undefined);
  setStore('taskProjectFilter', null);
  setStore('focusMode', false);
  setStore('tasks', reconcile({ one: task('one'), two: task('two'), three: task('three') }));
  setStore('agents', reconcile({}));
  setStore('taskGitStatus', reconcile({}));
  for (const id of ['one', 'two', 'three']) {
    setStore('agents', `${id}-agent`, {
      id: `${id}-agent`,
      taskId: id,
      def: {
        id: 'claude-code',
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
  setStore('taskOrder', ['one', 'two', 'three']);
  setStore('collapsedTaskOrder', []);
  setActiveTask('one');
  stop = startBackgroundTaskWatcher();
});

afterEach(() => {
  stop();
  for (const id of ['one', 'two', 'three']) {
    bringTaskToFront(id);
    clearAgentActivity(`${id}-agent`);
    removePrChecks(id);
  }
  vi.useRealTimers();
});

it('moves a running task to the back, keeps its agent, and focuses another task', () => {
  hook('working', 'UserPromptSubmit');
  sendTaskToBack('one');
  expect(store.taskOrder).toEqual(['two', 'three', 'one']);
  expect(store.activeTaskId).toBe('two');
  expect(store.activeAgentId).toBe('two-agent');
  expect(store.tasks.one.agentIds).toEqual(['one-agent']);
  expect(store.agents['one-agent'].status).toBe('running');
  expect(isTaskBackgrounded('one')).toBe(true);

  vi.advanceTimersByTime(1);
  hook('working', 'PostToolUse');
  expect(isTaskBackgrounded('one')).toBe(true);
});

it('hands selection to the neighbor, not the first task', () => {
  setActiveTask('three');
  sendTaskToBack('three');
  expect(store.activeTaskId).toBe('two');
});

it.each([
  ['waiting', 'PermissionRequest'],
  ['done', 'Stop'],
] as const)(
  'returns on %s without stealing focus or relying on OS notifications',
  (state, event) => {
    setStore('desktopNotificationsEnabled', false);
    hook('working', 'UserPromptSubmit');
    sendTaskToBack('one');
    hook(state, event);
    expect(store.taskOrder).toEqual(['one', 'two', 'three']);
    expect(isTaskBackgrounded('one')).toBe(false);
    expect(store.activeTaskId).toBe('two');
  },
);

it('returns when an idle agent becomes active again', () => {
  sendTaskToBack('one');
  markAgentBusy('one-agent');
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.taskOrder[0]).toBe('one');
});

it.each([{ stale: true }, { refreshing: true }, { error: 'Git refresh failed' }])(
  'stays in the background when Git status loses validity: %j',
  (flags) => {
    setStore('taskGitStatus', 'one', {
      has_committed_changes: true,
      has_uncommitted_changes: false,
      current_branch: 'one',
      base_branch: 'main',
      refreshedAt: Date.now(),
    });
    expect(getTaskAttentionState('one')).toBe('ready');
    sendTaskToBack('one');
    setStore('taskGitStatus', 'one', flags);
    expect(getTaskAttentionState('one')).toBe('idle');
    expect(isTaskBackgrounded('one')).toBe(true);
    setStore('taskGitStatus', 'one', { stale: false, refreshing: false, error: undefined });
    expect(getTaskAttentionState('one')).toBe('ready');
    expect(isTaskBackgrounded('one')).toBe(true);
    expect(store.taskOrder).toEqual(['two', 'three', 'one']);
  },
);

const prChecks: PrChecksState = {
  overall: 'pending',
  passing: 0,
  pending: 1,
  failing: 0,
  checks: [],
  checkedAt: '2026-10-09T10:00:00Z',
};

it.each(['one', 'three'])('returns when the remote PR for %s merges', (taskId) => {
  if (taskId === 'three') setStore('tasks', 'three', 'coordinatedBy', 'one');
  setPrChecks(taskId, { ...prChecks });
  sendTaskToBack('one');

  setPrChecks(taskId, { ...prChecks, overall: 'success', passing: 1, pending: 0 });
  expect(isTaskBackgrounded('one')).toBe(true);

  setPrChecks(taskId, { ...prChecks, overall: 'none', merged: true });
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.taskOrder[0]).toBe('one');
  expect(store.activeTaskId).toBe('two');
});

it('returns when a merged PR is first discovered after backgrounding', () => {
  sendTaskToBack('one');

  setPrChecks('one', { ...prChecks, overall: 'none', merged: true });
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.taskOrder[0]).toBe('one');
  expect(store.activeTaskId).toBe('two');
});

it('does not wake for an already merged PR or cleared PR state', () => {
  setPrChecks('one', { ...prChecks, overall: 'none', merged: true });
  sendTaskToBack('one');
  setPrChecks('one', { ...prChecks, overall: 'none', merged: true });
  expect(isTaskBackgrounded('one')).toBe(true);

  removePrChecks('one');
  expect(isTaskBackgrounded('one')).toBe(true);
});

it('returns when a later PR merges after the previous merge state clears', () => {
  setPrChecks('one', { ...prChecks, overall: 'none', merged: true });
  sendTaskToBack('one');

  setPrChecks('one', { ...prChecks, merged: false });
  expect(isTaskBackgrounded('one')).toBe(true);

  setPrChecks('one', { ...prChecks, overall: 'none', merged: true });
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.taskOrder[0]).toBe('one');
  expect(store.activeTaskId).toBe('two');
});

it('still returns when the task requests review', () => {
  sendTaskToBack('one');
  setStore('tasks', 'one', 'needsReview', true);
  expect(isTaskBackgrounded('one')).toBe(false);
});

it('keeps unresolved background questions in the attention tray', () => {
  hook('waiting', 'PermissionRequest');
  expect(computeAttentionEntries().map((entry) => entry.taskId)).toContain('one');
  sendTaskToBack('one');
  expect(computeAttentionEntries().filter((entry) => entry.kind === 'question')).toHaveLength(1);
  vi.advanceTimersByTime(1);
  hook('waiting', 'Notification');
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(computeAttentionEntries().map((entry) => entry.taskId)).toContain('one');
});

it('stays in the back when Claude re-reports a finished turn as idle', () => {
  hook('working', 'UserPromptSubmit');
  hook('done', 'Stop');
  sendTaskToBack('one');
  vi.advanceTimersByTime(60_000);
  hook('done', 'Notification');
  expect(isTaskBackgrounded('one')).toBe(true);
  expect(store.taskOrder).toEqual(['two', 'three', 'one']);

  hook('waiting', 'PermissionRequest');
  expect(isTaskBackgrounded('one')).toBe(false);
});

it('returns for a new turn after an idle re-report', () => {
  hook('done', 'Stop');
  sendTaskToBack('one');
  hook('done', 'Notification');
  hook('working', 'UserPromptSubmit');
  expect(isTaskBackgrounded('one')).toBe(false);
});

it.each([
  ['waiting', 'PermissionRequest'],
  ['working', 'UserPromptSubmit'],
] as const)('stays in the back when a %s hook claim goes stale', (state, event) => {
  hook(state, event);
  sendTaskToBack('one');
  vi.advanceTimersByTime(AGENT_HOOK_STALE_MS);
  expect(getAgentHookStatus('one-agent')).toBeNull();
  expect(isTaskBackgrounded('one')).toBe(true);

  // Expiry re-baselines the task; later activity still wakes it.
  hook('waiting', 'PermissionRequest');
  expect(isTaskBackgrounded('one')).toBe(false);
});

it('returns when terminal activity finishes after an unchanged hook expiry', () => {
  hook('working', 'UserPromptSubmit');
  sendTaskToBack('one');
  vi.advanceTimersByTime(AGENT_HOOK_STALE_MS - 1_000);
  markAgentBusy('one-agent');
  vi.advanceTimersByTime(1_000);
  expect(getAgentHookStatus('one-agent')).toBeNull();
  expect(getTaskAttentionState('one')).toBe('active');
  expect(isTaskBackgrounded('one')).toBe(true);

  vi.advanceTimersByTime(15_000);
  expect(getTaskAttentionState('one')).toBe('idle');
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.taskOrder).toEqual(['one', 'two', 'three']);
  expect(store.activeTaskId).toBe('two');
});

it('notices completion even when the task attention state stays at review', () => {
  setStore('tasks', 'one', 'needsReview', true);
  hook('working', 'UserPromptSubmit');
  sendTaskToBack('one');
  hook('done', 'Stop');
  expect(isTaskBackgrounded('one')).toBe(false);
});

it('brings a task forward when selected manually', () => {
  sendTaskToBack('one');
  setActiveTask('one');
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.taskOrder[0]).toBe('one');
  expect(store.activeTaskId).toBe('one');
});

it('keeps a coordinator and its children together and returns on child activity', () => {
  setStore('tasks', 'two', 'coordinatedBy', 'one');
  sendTaskToBack('one');
  expect(store.taskOrder).toEqual(['three', 'one', 'two']);
  hook('waiting', 'PermissionRequest', 'two');
  expect(store.taskOrder).toEqual(['one', 'two', 'three']);
  expect(store.activeTaskId).toBe('three');
});

it('keeps background child questions actionable while allowing manual return', () => {
  setStore('tasks', 'two', 'coordinatedBy', 'one');
  hook('waiting', 'PermissionRequest', 'two');
  sendTaskToBack('one');
  expect(isTaskBackgrounded('two')).toBe(true);
  expect(computeAttentionEntries().filter((entry) => entry.kind === 'question')).toHaveLength(1);
  bringTaskToFront('two');
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.taskOrder).toEqual(['one', 'two', 'three']);
  expect(computeAttentionEntries().map((entry) => entry.taskId)).toEqual(['two']);
});

it('returns a chat task when its turn finishes', () => {
  setStore('tasks', 'one', 'mainAgentView', 'chat');
  setStore('agents', 'one-agent', 'chatState', {
    status: 'working',
    items: [],
    requests: [],
  });
  sendTaskToBack('one');
  setStore('agents', 'one-agent', 'chatState', 'status', 'ready');
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.taskOrder[0]).toBe('one');
});

it('offers the action and a manual return in the task header', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const dispose = render(
    () => (
      <TaskTitleBar
        task={store.tasks.one}
        isActive={store.activeTaskId === 'one'}
        onClose={() => undefined}
        onFinish={() => undefined}
        pushing={false}
        pushSuccess={false}
        onTitleEditRef={() => undefined}
      />
    ),
    container,
  );
  try {
    const doLater = container.querySelector<HTMLButtonElement>('button[aria-label="Later"]');
    doLater?.click();
    const send = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'Snooze until new activity',
    );
    expect(send).toBeDefined();
    send?.click();
    expect(isTaskBackgrounded('one')).toBe(true);
    expect(container.textContent).toContain('Background');
    doLater?.click();
    const restore = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'Restore to front',
    );
    expect(restore).toBeDefined();
    restore?.click();
    expect(isTaskBackgrounded('one')).toBe(false);
    expect(container.textContent).not.toContain('Background');
  } finally {
    dispose();
    container.remove();
  }
});

it('can background the only task without immediately waking it', () => {
  setStore('taskOrder', ['one']);
  sendTaskToBack('one');
  expect(store.activeTaskId).toBeNull();
  expect(isTaskBackgrounded('one')).toBe(true);
  setActiveTask('one');
  expect(isTaskBackgrounded('one')).toBe(false);
});

it('forgets removed tasks without inserting them into the order', () => {
  sendTaskToBack('one');
  setStore('taskOrder', ['two', 'three']);
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.taskOrder).toEqual(['two', 'three']);
});

it('keeps the selected project when sending its active task to the back', () => {
  setStore('projects', [
    { id: 'project', name: 'Project', path: '/project', color: '#abc' },
    { id: 'other', name: 'Other', path: '/other', color: '#def' },
  ]);
  setStore('tasks', 'one', 'projectId', 'other');
  setActiveTask('two');
  setStore('taskProjectFilter', 'project');
  sendTaskToBack('two');
  expect(store.activeTaskId).toBe('three');
  expect(store.taskProjectFilter).toBe('project');
});

it('keeps timed snooze through new activity and restores at its deadline without taking focus', () => {
  const now = Date.now();
  sendTaskToBack('one', 2);
  expect(getTaskSnoozedUntil('one')).toBe(now + 2 * 3_600_000);
  hook('waiting', 'PermissionRequest');
  setStore('tasks', 'one', 'needsReview', true);
  expect(isTaskBackgrounded('one')).toBe(true);
  vi.advanceTimersByTime(2 * 3_600_000 - 1);
  expect(isTaskBackgrounded('one')).toBe(true);
  vi.advanceTimersByTime(1);
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(getTaskSnoozedUntil('one')).toBeUndefined();
  expect(store.taskOrder[0]).toBe('one');
  expect(store.activeTaskId).toBe('two');
});

it('replaces a snooze deadline and supports early manual restore', () => {
  sendTaskToBack('one', 1);
  vi.advanceTimersByTime(30 * 60_000);
  sendTaskToBack('one', 2);
  vi.advanceTimersByTime(30 * 60_000);
  expect(isTaskBackgrounded('one')).toBe(true);
  bringTaskToFront('one');
  sendTaskToBack('one');
  vi.advanceTimersByTime(2 * 3_600_000);
  expect(isTaskBackgrounded('one')).toBe(true);
  expect(getTaskSnoozedUntil('one')).toBeUndefined();
});

it('ends timed snooze when the task is selected', () => {
  sendTaskToBack('one', 1);
  setActiveTask('one');
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(getTaskSnoozedUntil('one')).toBeUndefined();
});

it('reschedules the whole snoozed coordinator group from a child', () => {
  setStore('tasks', 'two', 'coordinatedBy', 'one');
  sendTaskToBack('one', 1);
  sendTaskToBack('two', 2);
  expect(getTaskSnoozedUntil('one')).toBe(getTaskSnoozedUntil('two'));
  hook('waiting', 'PermissionRequest', 'two');
  vi.advanceTimersByTime(3_600_000);
  expect(isTaskBackgrounded('two')).toBe(true);
  vi.advanceTimersByTime(3_600_000);
  expect(store.taskOrder).toEqual(['one', 'two', 'three']);
  expect(isTaskBackgrounded('two')).toBe(false);
});

it('expires an overdue snooze after the clock jumps forward', () => {
  sendTaskToBack('one', 1);
  vi.setSystemTime(Date.now() + 2 * 3_600_000);
  vi.advanceTimersByTime(60_000);
  expect(isTaskBackgrounded('one')).toBe(false);
});

it('cancels scheduled work when the watcher is disposed', () => {
  sendTaskToBack('one', 1);
  stop();
  vi.advanceTimersByTime(3_600_000);
  expect(isTaskBackgrounded('one')).toBe(true);
});

it.each([0, -1, 0.001, 169, Infinity, NaN])('rejects invalid snooze hours: %s', (hours) => {
  sendTaskToBack('one', hours);
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.taskOrder).toEqual(['one', 'two', 'three']);
});

it('rebuilds a saved snooze and retains the original deadline after restart', () => {
  stop();
  const deadline = Date.now() + 30 * 60_000;
  setStore('tasks', 'one', 'snoozedUntil', deadline);
  setStore('taskOrder', ['two', 'three', 'one']);
  setActiveTask('two');
  stop = startBackgroundTaskWatcher();
  expect(getTaskSnoozedUntil('one')).toBe(deadline);
  hook('waiting', 'PermissionRequest');
  expect(isTaskBackgrounded('one')).toBe(true);
  vi.advanceTimersByTime(30 * 60_000);
  expect(store.taskOrder[0]).toBe('one');
  expect(store.activeTaskId).toBe('two');
  expect(store.tasks.one.snoozedUntil).toBeUndefined();
});

it('returns a task on startup when its saved deadline passed while the app was closed', () => {
  stop();
  setStore('tasks', 'one', 'snoozedUntil', Date.now() - 60_000);
  setStore('taskOrder', ['two', 'three', 'one']);
  setActiveTask('two');
  stop = startBackgroundTaskWatcher();
  vi.advanceTimersByTime(0);
  expect(store.taskOrder[0]).toBe('one');
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.tasks.one.snoozedUntil).toBeUndefined();
  expect(store.activeTaskId).toBe('two');
});

it('does not cancel a restored snooze through the saved active selection', () => {
  stop();
  setStore('taskOrder', ['one']);
  setStore('focusMode', true);
  setStore('tasks', 'one', 'snoozedUntil', Date.now() + 3_600_000);
  stop = startBackgroundTaskWatcher();
  expect(isTaskBackgrounded('one')).toBe(true);
  expect(store.activeTaskId).toBeNull();
  expect(store.activeAgentId).toBeNull();
  expect(store.focusMode).toBe(false);
});

it('restores coordinator snooze ownership even when a child was the saved selection', () => {
  stop();
  setStore('tasks', 'two', 'coordinatedBy', 'one');
  const deadline = Date.now() + 3_600_000;
  setStore('tasks', 'one', 'snoozedUntil', deadline);
  setActiveTask('two');
  stop = startBackgroundTaskWatcher();
  expect(getTaskSnoozedUntil('two')).toBe(deadline);
  expect(store.activeTaskId).toBe('three');
  bringTaskToFront('two');
  expect(store.tasks.one.snoozedUntil).toBeUndefined();
});

it('clears the durable deadline when switching to activity-based backgrounding', () => {
  sendTaskToBack('one', 2);
  expect(store.tasks.one.snoozedUntil).toBe(getTaskSnoozedUntil('one'));
  sendTaskToBack('one');
  expect(store.tasks.one.snoozedUntil).toBeUndefined();
  expect(isTaskBackgrounded('one')).toBe(true);
});

it('stops agents for an unchecked snooze and resumes the saved session without taking focus', async () => {
  const sessionId = 'fb4f2bc6-62d9-4b29-a795-240caf2fc459';
  setStore('tasks', 'one', 'agentSessionIds', { 'one-agent': sessionId });
  await snoozeTask('one', 1, false);
  expect(invoke).toHaveBeenCalledWith(IPC.KillAgent, { agentId: 'one-agent' });
  expect(store.tasks.one.collapsed).toBe(true);
  expect(store.tasks.one.agentIds).toEqual([]);
  expect(store.tasks.one.savedAgentSessionIds).toEqual([sessionId]);
  expect(isTaskBackgrounded('one')).toBe(true);
  const selectedTask = store.activeTaskId;
  const selectedAgent = store.activeAgentId;
  setStore('taskProjectFilter', 'other');
  vi.advanceTimersByTime(3_600_000);
  expect(store.tasks.one.collapsed).toBe(false);
  const resumedId = store.tasks.one.agentIds[0];
  expect(store.agents[resumedId].resumed).toBe(true);
  expect(store.tasks.one.agentSessionIds?.[resumedId]).toBe(sessionId);
  expect(store.taskOrder[0]).toBe('one');
  expect(store.activeTaskId).toBe(selectedTask);
  expect(store.activeAgentId).toBe(selectedAgent);
  expect(store.taskProjectFilter).toBe('other');
});

it('allows early manual restoration of a stopped snooze and cancels its timer', async () => {
  await snoozeTask('one', 1, false);
  uncollapseTask('one');
  expect(store.tasks.one.snoozedUntil).toBeUndefined();
  expect(isTaskBackgrounded('one')).toBe(false);
  const agentIds = [...store.tasks.one.agentIds];
  vi.advanceTimersByTime(3_600_000);
  expect(store.tasks.one.agentIds).toEqual(agentIds);
});

it('restores a stopped snooze after restarting the app', () => {
  stop();
  const def = store.agents['one-agent'].def;
  setStore('tasks', 'one', {
    collapsed: true,
    agentIds: [],
    savedAgentDefs: [def],
    snoozedUntil: Date.now() + 3_600_000,
  });
  setStore('taskOrder', ['two', 'three']);
  setStore('collapsedTaskOrder', ['one']);
  setActiveTask('two');
  stop = startBackgroundTaskWatcher();
  vi.advanceTimersByTime(3_600_000 - 1);
  expect(store.tasks.one.collapsed).toBe(true);
  vi.advanceTimersByTime(1);
  expect(store.tasks.one.collapsed).toBe(false);
  expect(store.tasks.one.agentIds).toHaveLength(1);
  expect(store.activeTaskId).toBe('two');
});

it('does not resurrect a stopped snooze that is being closed', async () => {
  await snoozeTask('one', 1, false);
  setStore('tasks', 'one', 'closingStatus', 'removing');
  vi.advanceTimersByTime(3_600_000);
  expect(store.tasks.one.collapsed).toBe(true);
  expect(store.taskOrder).not.toContain('one');
  expect(isTaskBackgrounded('one')).toBe(false);
});

it.each([{ coordinatorMode: true }, { delegationParent: true }, { coordinatedBy: 'parent' }])(
  'does not stop coordinator-managed tasks: %j',
  async (fields) => {
    setStore('tasks', 'one', fields);
    await snoozeTask('one', 1, false);
    expect(store.tasks.one.collapsed).not.toBe(true);
    expect(invoke).not.toHaveBeenCalledWith(IPC.KillAgent, expect.anything());
    expect(isTaskBackgrounded('one')).toBe(false);
  },
);

it('cancels a running snooze when the user explicitly minimizes the task', async () => {
  sendTaskToBack('one', 1);
  await collapseTask('one');
  expect(store.tasks.one.snoozedUntil).toBeUndefined();
  expect(isTaskBackgrounded('one')).toBe(false);
  vi.advanceTimersByTime(3_600_000);
  expect(store.tasks.one.collapsed).toBe(true);
  expect(store.tasks.one.agentIds).toEqual([]);
  expect(store.taskOrder).not.toContain('one');
});
