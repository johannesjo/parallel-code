import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore, store } from './core';
import { getPullRequestDetails, loadFailedChecksPrompt } from './github';
import { showNotification } from './notification';
import { prBabysitStatus, startPrBabysit, startPrBabysitWatcher } from './pr-babysit';
import {
  extraPrWatchId,
  forgetTaskPrsDetected,
  markPrimaryPrClosed,
  markTaskPrsDetected,
  removePrChecks,
  setPrChecks,
  setTaskExtraPrs,
  type PrChecksState,
} from './pr-checks-state';
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
  // Babysit sends only the CI logs of PRs the user opened.
  getPullRequestDetails: vi.fn(() => Promise.resolve({ authoredByViewer: true })),
  loadFailedChecksPrompt: vi.fn(() => Promise.resolve('fix CI')),
}));

const prUrl = 'https://github.com/acme/app/pull/12';
const extraUrl = 'https://github.com/acme/lib/pull/3';
const extraWatchId = extraPrWatchId('task-1', extraUrl);
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
  removePrChecks(extraWatchId);
  setTaskExtraPrs('task-1', []);
  markPrimaryPrClosed('task-1', undefined);
  forgetTaskPrsDetected();
  setStore('tasks', reconcile({}));
  setStore('agents', reconcile({}));
  vi.clearAllMocks();
  vi.mocked(isAgentIdle).mockReturnValue(true);
  // clearAllMocks keeps implementations a test set.
  vi.mocked(loadFailedChecksPrompt).mockImplementation(() => Promise.resolve('fix CI'));
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

it('sends the failures of an additional PR while the primary one passes', async () => {
  setPrChecks('task-1', { ...failing('a'), overall: 'success', failing: 0 });
  setTaskExtraPrs('task-1', [{ url: extraUrl, repo: 'lib' }]);
  setPrChecks(extraWatchId, failing('x'));
  stop = startPrBabysitWatcher();
  await tick();
  expect(loadFailedChecksPrompt).toHaveBeenCalledWith({ number: 3, url: extraUrl, repo: 'lib' });
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  expect(store.tasks['task-1']?.prBabysit).toEqual({ attempts: 1, lastSentSha: 'x' });
});

it('sends the failures of every failing PR together', async () => {
  setPrChecks('task-1', failing('a'));
  setTaskExtraPrs('task-1', [{ url: extraUrl, repo: 'lib' }]);
  setPrChecks(extraWatchId, failing('x'));
  vi.mocked(loadFailedChecksPrompt)
    .mockResolvedValueOnce('fix app')
    .mockResolvedValueOnce('fix lib');
  stop = startPrBabysitWatcher();
  await tick();
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  expect(sendPrompt).toHaveBeenCalledWith('task-1', 'agent-1', 'fix app\n\nfix lib', {
    appPrompt: true,
  });
  expect(store.tasks['task-1']?.prBabysit).toEqual({ attempts: 1, lastSentSha: 'a,x' });
});

it('sends only the newly failing PR when another one starts failing', async () => {
  vi.mocked(loadFailedChecksPrompt).mockImplementation(async ({ url }) =>
    url === prUrl ? 'fix app' : 'fix lib',
  );
  setPrChecks('task-1', failing('a'));
  setTaskExtraPrs('task-1', [{ url: extraUrl, repo: 'lib' }]);
  setPrChecks(extraWatchId, { ...failing('x'), overall: 'success', failing: 0 });
  stop = startPrBabysitWatcher();
  await tick();
  await tick();
  expect(sendPrompt).toHaveBeenLastCalledWith('task-1', 'agent-1', 'fix app', {
    appPrompt: true,
  });

  // The agent already has the app's failure; only the library's is new.
  setPrChecks(extraWatchId, failing('x'));
  await tick();
  expect(sendPrompt).toHaveBeenCalledTimes(2);
  expect(sendPrompt).toHaveBeenLastCalledWith('task-1', 'agent-1', 'fix lib', {
    appPrompt: true,
  });
  expect(store.tasks['task-1']?.prBabysit).toEqual({ attempts: 2, lastSentSha: 'a,x' });
});

it('sends a push that still fails, without the other PR it already sent', async () => {
  vi.mocked(loadFailedChecksPrompt).mockImplementation(async ({ url }) =>
    url === prUrl ? 'fix app' : 'fix lib',
  );
  setPrChecks('task-1', failing('a'));
  setTaskExtraPrs('task-1', [{ url: extraUrl, repo: 'lib' }]);
  setPrChecks(extraWatchId, failing('x'));
  stop = startPrBabysitWatcher();
  await tick();
  await tick();
  expect(sendPrompt).toHaveBeenLastCalledWith('task-1', 'agent-1', 'fix app\n\nfix lib', {
    appPrompt: true,
  });

  setPrChecks('task-1', failing('a2'));
  await tick();
  expect(sendPrompt).toHaveBeenCalledTimes(2);
  expect(sendPrompt).toHaveBeenLastCalledWith('task-1', 'agent-1', 'fix app', {
    appPrompt: true,
  });
  expect(store.tasks['task-1']?.prBabysit).toEqual({ attempts: 2, lastSentSha: 'a2,x' });
});

it('keeps babysitting when a newly failing PR has nothing to send beside one already sent', async () => {
  vi.mocked(loadFailedChecksPrompt).mockImplementation(async ({ url }) =>
    url === prUrl ? 'fix app' : null,
  );
  setPrChecks('task-1', failing('a'));
  setTaskExtraPrs('task-1', [{ url: extraUrl, repo: 'lib' }]);
  setPrChecks(extraWatchId, { ...failing('x'), overall: 'success', failing: 0 });
  stop = startPrBabysitWatcher();
  await tick();
  await tick();
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  vi.mocked(showNotification).mockClear();

  // Only a merge conflict, say: nothing new to send while the agent still fixes the app.
  setPrChecks(extraWatchId, failing('x'));
  await tick();
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  expect(store.tasks['task-1']?.prBabysit).toEqual({ attempts: 1, lastSentSha: 'a,x' });
  expect(showNotification).not.toHaveBeenCalled();
});

it('turns off once the primary PR closes and no other PR is open', async () => {
  setPrChecks('task-1', { ...failing('a'), overall: 'pending' });
  markTaskPrsDetected('task-1');
  stop = startPrBabysitWatcher();
  await tick();
  expect(store.tasks['task-1']?.prBabysit).toBeDefined();
  markPrimaryPrClosed('task-1', prUrl);
  removePrChecks('task-1');
  await tick();
  expect(store.tasks['task-1']?.prBabysit).toBeUndefined();
});

it('turns off once the last PR of the task closes', async () => {
  setStore('tasks', 'task-1', 'prUrl', undefined);
  setTaskExtraPrs('task-1', [{ url: extraUrl, repo: 'lib' }]);
  setPrChecks(extraWatchId, { ...failing('x'), overall: 'pending' });
  markTaskPrsDetected('task-1');
  stop = startPrBabysitWatcher();
  await tick();
  expect(store.tasks['task-1']?.prBabysit).toBeDefined();
  // Closed unmerged: nothing is left to babysit, and no toggle shows to turn it off.
  setTaskExtraPrs('task-1', []);
  removePrChecks(extraWatchId);
  await tick();
  expect(store.tasks['task-1']?.prBabysit).toBeUndefined();
});

it("waits for the task's other PRs to be found before stopping on a merge", async () => {
  setPrChecks('task-1', { ...failing('a'), overall: 'none', merged: true });
  stop = startPrBabysitWatcher();
  await tick();
  // Right after a restart only the primary PR is known; another may still be open.
  expect(store.tasks['task-1']?.prBabysit).toEqual({ attempts: 0 });
  markTaskPrsDetected('task-1');
  await tick();
  expect(store.tasks['task-1']?.prBabysit).toBeUndefined();
});

it('keeps babysitting an open PR after another one merged', async () => {
  setPrChecks('task-1', { ...failing('a'), overall: 'none', merged: true });
  setTaskExtraPrs('task-1', [{ url: extraUrl, repo: 'lib' }]);
  setPrChecks(extraWatchId, failing('x'));
  stop = startPrBabysitWatcher();
  await tick();
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  expect(store.tasks['task-1']?.prBabysit).toEqual({ attempts: 1, lastSentSha: 'x' });
});

it('stops instead of sending the CI logs of a PR the user did not open', async () => {
  // Not one the tests above confirmed: confirmed authorship is remembered.
  const otherUrl = 'https://github.com/acme/other/pull/9';
  setTaskExtraPrs('task-1', [{ url: otherUrl, repo: 'other' }]);
  setPrChecks('task-1', { ...failing('a'), overall: 'success', failing: 0 });
  setPrChecks(extraPrWatchId('task-1', otherUrl), failing('x'));
  vi.mocked(getPullRequestDetails).mockResolvedValueOnce({
    authoredByViewer: false,
  } as PullRequestDetails);
  stop = startPrBabysitWatcher();
  await tick();
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(store.tasks['task-1']?.prBabysit).toBeUndefined();
  expect(showNotification).toHaveBeenCalledWith(
    'Babysit stopped: Babysit is only available for pull requests you opened.',
  );
  removePrChecks(extraPrWatchId('task-1', otherUrl));
});

it('turns on for a task whose only PR is an additional one', async () => {
  setStore('tasks', 'task-1', { prUrl: undefined, prBabysit: undefined });
  setTaskExtraPrs('task-1', [{ url: extraUrl, repo: 'lib' }]);
  expect(await startPrBabysit('task-1')).toBe(true);
  expect(getPullRequestDetails).toHaveBeenCalledWith(extraUrl);
});

it('babysits the open PRs of a task whose primary PR was closed', async () => {
  markPrimaryPrClosed('task-1', prUrl);
  setTaskExtraPrs('task-1', [{ url: extraUrl, repo: 'lib' }]);
  setPrChecks(extraWatchId, failing('x'));
  stop = startPrBabysitWatcher();
  await tick();
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  expect(loadFailedChecksPrompt).toHaveBeenCalledWith({ number: 3, url: extraUrl, repo: 'lib' });
});

it('keeps sending for a confirmed PR when gh later cannot confirm it', async () => {
  setStore('tasks', 'task-1', 'prBabysit', undefined);
  expect(await startPrBabysit('task-1')).toBe(true);
  vi.mocked(getPullRequestDetails).mockResolvedValue({} as PullRequestDetails);
  setPrChecks('task-1', failing('a'));
  stop = startPrBabysitWatcher();
  await tick();
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  expect(store.tasks['task-1']?.prBabysit).toEqual({ attempts: 1, lastSentSha: 'a' });
  vi.mocked(getPullRequestDetails).mockResolvedValue({
    authoredByViewer: true,
  } as PullRequestDetails);
});
