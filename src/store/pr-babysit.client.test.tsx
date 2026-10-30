import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore, store } from './core';
import { getPullRequestDetails, loadFailedChecksPrompt } from './github';
import { showNotification } from './notification';
import { prBabysitStatus, startPrBabysit, startPrBabysitWatcher } from './pr-babysit';
import { removePrChecks, setPrChecks, type PrChecksState } from './pr-checks-state';
import { sendPrompt } from './tasks';
import { isAgentIdle } from './taskStatus';
import type { PullRequestDetails } from '../ipc/types';
import type { Agent, Task } from './types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));
vi.mock('./persistence', () => ({ saveState: vi.fn(() => Promise.resolve()) }));
vi.mock('./notification', () => ({ showNotification: vi.fn() }));
vi.mock('./tasks', () => ({ sendPrompt: vi.fn(() => Promise.resolve()) }));
vi.mock('./taskStatus', () => ({
  isAgentIdle: vi.fn(() => true),
  isAgentAskingQuestion: () => false,
}));
vi.mock('./github', () => ({
  getPullRequestDetails: vi.fn(),
  loadFailedChecksPrompt: vi.fn(() => Promise.resolve('fix CI')),
}));

const prUrl = 'https://github.com/acme/app/pull/12';
let stop: (() => void) | undefined;

function failing(headSha: string): PrChecksState {
  return {
    overall: 'failure',
    headSha,
    passing: 1,
    pending: 0,
    failing: 1,
    checks: [{ name: 'test', bucket: 'fail' }],
    checkedAt: '2026-10-23T00:00:00Z',
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Task',
    projectId: 'project-1',
    branchName: 'task/task-1',
    worktreePath: '/repo/.worktrees/task-1',
    agentIds: ['agent-1'],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
    prUrl,
    prBabysit: { attempts: 0 },
    ...overrides,
  };
}

async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  setStore('tasks', reconcile({ 'task-1': task() }));
  setStore(
    'agents',
    reconcile({ 'agent-1': { id: 'agent-1', taskId: 'task-1', status: 'running' } as Agent }),
  );
});

afterEach(() => {
  stop?.();
  stop = undefined;
  removePrChecks('task-1');
  setStore('tasks', reconcile({}));
  setStore('agents', reconcile({}));
  vi.clearAllMocks();
  vi.mocked(isAgentIdle).mockReturnValue(true);
  vi.useRealTimers();
});

it('sends each failing commit to the agent once', async () => {
  setPrChecks('task-1', failing('a'));
  stop = startPrBabysitWatcher();
  await tick();
  await tick();
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  expect(sendPrompt).toHaveBeenCalledWith('task-1', 'agent-1', 'fix CI', { appPrompt: true });

  setPrChecks('task-1', failing('b'));
  await tick();
  expect(sendPrompt).toHaveBeenCalledTimes(2);
  expect(store.tasks['task-1']?.prBabysit).toEqual({ attempts: 2, lastSentSha: 'b' });
});

it('tells the user when the agent does not start on the sent failures', async () => {
  setPrChecks('task-1', failing('a'));
  stop = startPrBabysitWatcher();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(showNotification).toHaveBeenLastCalledWith(
    expect.stringContaining('the agent did not start'),
  );
});

it('stays quiet when the agent starts on the sent failures', async () => {
  vi.mocked(sendPrompt).mockImplementationOnce(() => {
    vi.mocked(isAgentIdle).mockReturnValue(false);
    return Promise.resolve();
  });
  setPrChecks('task-1', failing('a'));
  stop = startPrBabysitWatcher();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(showNotification).not.toHaveBeenCalledWith(
    expect.stringContaining('the agent did not start'),
  );
});

it('holds the failures while the user has an unsent draft', async () => {
  setStore('tasks', 'task-1', 'promptDraft', 'half-typed');
  setPrChecks('task-1', failing('a'));
  stop = startPrBabysitWatcher();
  await tick();
  expect(sendPrompt).not.toHaveBeenCalled();

  setStore('tasks', 'task-1', 'promptDraft', undefined);
  await tick();
  expect(sendPrompt).toHaveBeenCalledTimes(1);
});

it('says what it is waiting for', async () => {
  setStore('tasks', 'task-1', 'promptDraft', 'half-typed');
  setPrChecks('task-1', failing('a'));
  expect(prBabysitStatus('task-1')).toBe(
    'CI failed; waiting: Your draft in the task prompt is unsent',
  );

  setStore('tasks', 'task-1', 'promptDraft', undefined);
  stop = startPrBabysitWatcher();
  await tick();
  expect(prBabysitStatus('task-1')).toBe('Waiting for a new push');
});

it('tells the user when a failing commit has nothing to send', async () => {
  vi.mocked(loadFailedChecksPrompt).mockResolvedValueOnce(null);
  setPrChecks('task-1', failing('a'));
  stop = startPrBabysitWatcher();
  await tick();
  expect(sendPrompt).not.toHaveBeenCalled();
  // Babysit cannot act on this commit, so it is the user's at once.
  expect(store.tasks['task-1']?.prBabysit).toEqual({
    attempts: 0,
    lastSentSha: 'a',
    stalled: true,
  });
  expect(showNotification).toHaveBeenCalledWith(
    expect.stringContaining('could not load a failing check'),
  );
});

it('hands the failure back when the agent stops without pushing a fix', async () => {
  setPrChecks('task-1', failing('a'));
  stop = startPrBabysitWatcher();
  await tick();
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  // A push the local origin ref misses still shows at the 5-minute refresh.
  await vi.advanceTimersByTimeAsync(5.5 * 60_000);
  expect(store.tasks['task-1']?.prBabysit?.stalled).toBeUndefined();

  await vi.advanceTimersByTimeAsync(40_000);
  expect(store.tasks['task-1']?.prBabysit).toEqual({
    attempts: 1,
    lastSentSha: 'a',
    stalled: true,
  });
  expect(prBabysitStatus('task-1')).toBe('Stuck: CI still fails and no fix was pushed');
  expect(showNotification).toHaveBeenLastCalledWith(expect.stringContaining('no fix was pushed'));

  // A push from anywhere, such as the user's own terminal, resumes babysitting.
  setPrChecks('task-1', { ...failing('b'), overall: 'pending' });
  await tick();
  expect(store.tasks['task-1']?.prBabysit).toEqual({ attempts: 1, lastSentSha: 'a' });
});

it('starts over once CI passes', async () => {
  setStore('tasks', 'task-1', 'prBabysit', { attempts: 2, lastSentSha: 'a', stalled: true });
  setPrChecks('task-1', { ...failing('b'), overall: 'success' });
  stop = startPrBabysitWatcher();
  await tick();
  expect(store.tasks['task-1']?.prBabysit).toStrictEqual({ attempts: 0 });
});

it('gives a nudged agent a fresh chance to push', async () => {
  setStore('tasks', 'task-1', 'prBabysit', { attempts: 1, lastSentSha: 'a', stalled: true });
  setPrChecks('task-1', failing('a'));
  stop = startPrBabysitWatcher();
  vi.mocked(isAgentIdle).mockReturnValue(false);
  await tick();
  expect(store.tasks['task-1']?.prBabysit).toStrictEqual({ attempts: 1, lastSentSha: 'a' });
  expect(prBabysitStatus('task-1')).toBe('Waiting for a new push');
});

it('does not count a paused task as stuck', async () => {
  setStore('tasks', 'task-1', 'prBabysit', { attempts: 1, lastSentSha: 'a' });
  setStore('tasks', 'task-1', 'delegationPaused', true);
  setPrChecks('task-1', failing('a'));
  stop = startPrBabysitWatcher();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(store.tasks['task-1']?.prBabysit?.stalled).toBeUndefined();
});

it('does not call a working agent stuck', async () => {
  vi.mocked(sendPrompt).mockImplementationOnce(() => {
    vi.mocked(isAgentIdle).mockReturnValue(false);
    return Promise.resolve();
  });
  setPrChecks('task-1', failing('a'));
  stop = startPrBabysitWatcher();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(store.tasks['task-1']?.prBabysit?.stalled).toBeUndefined();
});

it('stops and tells the user after the last attempt fails', async () => {
  setStore('tasks', 'task-1', 'prBabysit', { attempts: 3, lastSentSha: 'c' });
  setPrChecks('task-1', failing('d'));
  stop = startPrBabysitWatcher();
  await tick();
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(store.tasks['task-1']?.prBabysit).toBeUndefined();
  expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('3 fix attempts'));
});

it('stops when collecting the failures fails instead of retrying', async () => {
  vi.mocked(loadFailedChecksPrompt).mockRejectedValueOnce(new Error('gh offline'));
  setPrChecks('task-1', failing('a'));
  stop = startPrBabysitWatcher();
  await tick();
  expect(store.tasks['task-1']?.prBabysit).toBeUndefined();
  expect(showNotification).toHaveBeenCalledWith('Babysit stopped: gh offline');
});

it('only turns on for pull requests the user opened', async () => {
  setStore('tasks', 'task-1', 'prBabysit', undefined);
  vi.mocked(getPullRequestDetails).mockResolvedValueOnce({
    authoredByViewer: false,
  } as PullRequestDetails);
  expect(await startPrBabysit('task-1')).toBe(false);
  expect(store.tasks['task-1']?.prBabysit).toBeUndefined();

  vi.mocked(getPullRequestDetails).mockResolvedValueOnce({
    authoredByViewer: true,
  } as PullRequestDetails);
  expect(await startPrBabysit('task-1')).toBe(true);
  expect(store.tasks['task-1']?.prBabysit).toEqual({ attempts: 0 });
});
