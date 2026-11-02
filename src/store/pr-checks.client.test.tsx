import { createRoot, createSignal } from 'solid-js';
import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { fireAndForget, invoke } from '../lib/ipc';
import { setStore } from './core';
import { startPrChecksSubscription } from './pr-checks';
import { notePrintedPrLink } from './printed-pr-links';
import { extraPrWatchId, getTaskExtraPrs, setTaskExtraPrs } from './pr-checks-state';
import type { Task } from './types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));
vi.mock('./persistence', () => ({ saveState: vi.fn(() => Promise.resolve()) }));

// The real activity tracking needs PTY output and idle timers; a signal stands in.
const [workingTasks, setWorkingTasks] = createSignal<string[]>([]);
vi.mock('./taskStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./taskStatus')>()),
  isTaskWorking: (taskId: string) => workingTasks().includes(taskId),
}));

const primaryUrl = 'https://github.com/acme/app/pull/12';
const apiUrl = 'https://github.com/acme/api/pull/7';
const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function task(overrides: Partial<Task> = {}): Task {
  return {
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
    ...overrides,
  };
}

let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.mocked(invoke).mockResolvedValue({ url: primaryUrl, extras: [{ url: apiUrl, repo: 'api' }] });
  vi.stubGlobal('electron', { ipcRenderer: { on: () => () => {} } });
  setStore('taskOrder', ['task-1']);
  setStore('collapsedTaskOrder', []);
  setStore('tasks', reconcile({ 'task-1': task() }));
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  setWorkingTasks([]);
  setTaskExtraPrs('task-1', []);
  setStore('taskOrder', []);
  setStore('tasks', reconcile({}));
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function startWithExtraPr(): Promise<void> {
  createRoot((d) => {
    dispose = d;
    startPrChecksSubscription();
  });
  await flushPromises();
  expect(getTaskExtraPrs('task-1')).toEqual([{ url: apiUrl, repo: 'api' }]);
  vi.mocked(fireAndForget).mockClear();
}

const stopApi = { watchId: extraPrWatchId('task-1', apiUrl) };

it('stops watching a removed task’s additional PRs', async () => {
  await startWithExtraPr();

  setStore('taskOrder', []);
  setStore('tasks', reconcile({}));

  expect(fireAndForget).toHaveBeenCalledWith(IPC.StopPrChecksWatcher, stopApi);
  expect(getTaskExtraPrs('task-1')).toEqual([]);
});

it('stops watching additional PRs once the task leaves its worktree', async () => {
  await startWithExtraPr();

  setStore('tasks', 'task-1', 'gitIsolation', 'direct');

  expect(fireAndForget).toHaveBeenCalledWith(IPC.StopPrChecksWatcher, stopApi);
  expect(getTaskExtraPrs('task-1')).toEqual([]);
});

it('probes the branch again as soon as an agent turn ends', async () => {
  vi.mocked(invoke).mockResolvedValue({ url: null });
  setStore('tasks', reconcile({ 'task-1': task({ prUrl: undefined }) }));
  createRoot((d) => {
    dispose = d;
    startPrChecksSubscription();
  });
  await flushPromises();

  // The turn runs `gh pr create`; probes still wait out the retry window meanwhile.
  setWorkingTasks(['task-1']);
  await flushPromises();
  expect(invoke).toHaveBeenCalledTimes(1);

  vi.mocked(invoke).mockResolvedValue({ url: primaryUrl });
  setWorkingTasks([]);
  await flushPromises();

  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith(IPC.DetectPrForBranch, {
    worktreePath: '/repo/.worktrees/task-1',
    branchName: 'task/task-1',
  });
});

it('probes the branch again once its terminal prints a PR link', async () => {
  vi.mocked(invoke).mockResolvedValue({ url: null });
  setStore('tasks', reconcile({ 'task-1': task({ prUrl: undefined }) }));
  createRoot((d) => {
    dispose = d;
    startPrChecksSubscription();
  });
  await flushPromises();
  expect(invoke).toHaveBeenCalledTimes(1);

  // A `!` command runs `gh pr create` without any agent hook marking a turn.
  vi.mocked(invoke).mockResolvedValue({ url: primaryUrl });
  const output = `${primaryUrl}\r\n`;
  notePrintedPrLink('agent-1', 'task-1', { tail: output, chunk: output });
  await flushPromises();

  expect(invoke).toHaveBeenCalledTimes(2);
});
