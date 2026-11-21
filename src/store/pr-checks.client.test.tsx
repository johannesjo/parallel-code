import { createRoot, createSignal } from 'solid-js';
import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { fireAndForget, invoke } from '../lib/ipc';
import { setStore } from './core';
import { startPrChecksSubscription } from './pr-checks';
import { notePrintedPrLink } from './printed-pr-links';
import {
  extraPrWatchId,
  getTaskExtraPrs,
  markPrimaryPrClosed,
  setTaskExtraPrs,
} from './pr-checks-state';
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
  markPrimaryPrClosed('task-1', undefined);
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

it('polls the task’s PRs once an agent turn ends', async () => {
  await startWithExtraPr();

  // The turn may run `gh pr merge`, which moves no ref the watcher could notice.
  setWorkingTasks(['task-1']);
  await flushPromises();
  expect(invoke).not.toHaveBeenCalledWith(IPC.RefreshPrChecksWatcher, expect.anything());
  setWorkingTasks([]);
  await flushPromises();

  expect(invoke).toHaveBeenCalledWith(IPC.RefreshPrChecksWatcher, {
    taskId: 'task-1',
    pushed: false,
  });
});

// A task created from `origin/main` tracks it, and its PRs must not pass for the task's.
it('names the branch the task is based on without a printed PR link', async () => {
  vi.mocked(invoke).mockResolvedValue({ url: null });
  setStore('tasks', reconcile({ 'task-1': task({ prUrl: undefined, baseBranch: 'origin/main' }) }));
  createRoot((d) => {
    dispose = d;
    startPrChecksSubscription();
  });
  await flushPromises();

  expect(invoke).toHaveBeenLastCalledWith(IPC.DetectPrForBranch, {
    worktreePath: '/repo/.worktrees/task-1',
    branchName: 'task/task-1',
    baseBranch: 'origin/main',
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
  // A PR pushed under another branch name is found only through the printed link.
  expect(invoke).toHaveBeenLastCalledWith(IPC.DetectPrForBranch, {
    worktreePath: '/repo/.worktrees/task-1',
    branchName: 'task/task-1',
    printedPrUrl: primaryUrl,
  });
});

// The printed-link signal outlives each test, so a fresh subscription reacts to
// the last test's link once; these count only the calls after start-up.
async function startAndPrint(
  overrides: Partial<Task>,
  agentId: string,
  printedProbeResult: unknown = { url: null },
): Promise<number> {
  vi.mocked(invoke).mockImplementation((_channel, args) =>
    Promise.resolve(
      args && typeof args === 'object' && 'printedPrUrl' in args
        ? printedProbeResult
        : { url: null },
    ),
  );
  setStore('tasks', reconcile({ 'task-1': task(overrides) }));
  createRoot((d) => {
    dispose = d;
    startPrChecksSubscription();
  });
  await flushPromises();
  vi.mocked(invoke).mockClear();
  const output = `${apiUrl}\r\n`;
  notePrintedPrLink(agentId, 'task-1', { tail: output, chunk: output });
  await flushPromises();
  return vi.mocked(invoke).mock.calls.length;
}

it('checks a printed PR link on one probe only', async () => {
  expect(await startAndPrint({ prUrl: undefined }, 'agent-2')).toBe(1);
  expect(invoke).toHaveBeenLastCalledWith(IPC.DetectPrForBranch, {
    worktreePath: '/repo/.worktrees/task-1',
    branchName: 'task/task-1',
    printedPrUrl: apiUrl,
  });

  setWorkingTasks(['task-1']);
  await flushPromises();
  setWorkingTasks([]);
  await flushPromises();

  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith(IPC.DetectPrForBranch, {
    worktreePath: '/repo/.worktrees/task-1',
    branchName: 'task/task-1',
  });
});

it('does not check a printed PR link for a task that has a PR', async () => {
  expect(await startAndPrint({}, 'agent-3')).toBe(1);
  expect(invoke).not.toHaveBeenCalledWith(
    IPC.DetectPrForBranch,
    expect.objectContaining({ printedPrUrl: expect.anything() }),
  );
});

it('keeps a printed PR link for the next probe when the lookup failed', async () => {
  const failed = { url: null, extras: [], failedRepos: ['.'] };
  expect(await startAndPrint({ prUrl: undefined }, 'agent-5', failed)).toBe(1);

  setWorkingTasks(['task-1']);
  await flushPromises();
  setWorkingTasks([]);
  await flushPromises();

  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith(IPC.DetectPrForBranch, {
    worktreePath: '/repo/.worktrees/task-1',
    branchName: 'task/task-1',
    printedPrUrl: apiUrl,
  });
});

it('checks a printed PR link for a task whose PR was closed', async () => {
  markPrimaryPrClosed('task-1', primaryUrl);

  expect(await startAndPrint({}, 'agent-6')).toBe(1);
  expect(invoke).toHaveBeenLastCalledWith(
    IPC.DetectPrForBranch,
    expect.objectContaining({ printedPrUrl: apiUrl }),
  );
});

// A child holds its coordinator's commits, so the coordinator's PR must not pass as its own.
it('names the branch the task is based on along with a printed PR link', async () => {
  expect(await startAndPrint({ prUrl: undefined, baseBranch: 'task/parent' }, 'agent-7')).toBe(1);
  expect(invoke).toHaveBeenLastCalledWith(IPC.DetectPrForBranch, {
    worktreePath: '/repo/.worktrees/task-1',
    branchName: 'task/task-1',
    printedPrUrl: apiUrl,
    baseBranch: 'task/parent',
  });
});

// Until the link is checked the task's PRs count as unknown, which holds up Babysit.
it('gives up on a printed PR link after three failed lookups', async () => {
  const failed = { url: null, extras: [], failedRepos: ['.'] };
  expect(await startAndPrint({ prUrl: undefined }, 'agent-8', failed)).toBe(1);
  for (let turn = 0; turn < 3; turn++) {
    setWorkingTasks(['task-1']);
    await flushPromises();
    setWorkingTasks([]);
    await flushPromises();
  }

  const withLink = vi
    .mocked(invoke)
    .mock.calls.filter(([, args]) => args && typeof args === 'object' && 'printedPrUrl' in args);
  expect(withLink).toHaveLength(3);
  expect(invoke).toHaveBeenCalledTimes(4);
});
