import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStartRequest, mockLoadTaskDiff, mockNotify } = vi.hoisted(() => ({
  mockStartRequest: vi.fn(),
  mockLoadTaskDiff: vi.fn(),
  mockNotify: vi.fn(),
}));

vi.mock('../lib/model-request', () => ({ startModelRequest: mockStartRequest }));
vi.mock('../lib/load-task-diff', () => ({
  loadTaskDiff: mockLoadTaskDiff,
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
}));
vi.mock('./notification', () => ({ showNotification: mockNotify, NOTIFICATION_ERROR_MS: 10_000 }));
vi.mock('./tasks', () => ({ sendPrompt: vi.fn(), uncollapseTask: vi.fn() }));
vi.mock('./projects', () => ({ getProjectPath: () => '/repo' }));
vi.mock('./agentHookStatus', () => ({ getAgentHookStatus: () => null }));
vi.mock('./agent-chat', () => ({ isAgentChat: () => false }));
vi.mock('./taskStatus', () => ({
  isTaskWorking: () => false,
  getAgentOutputTail: () => '',
  normalizeCurrentFrame: (text: string) => text,
}));

import { store, setStore } from './core';
import type { Task } from './types';
import { cancelTaskReview, setTaskReviewModel, startTaskReview } from './task-review';

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+change';
const RATING = {
  scores: [
    { label: 'Correct', score: 80, why: 'No test for the redirect.' },
    { label: 'Complete', score: 90, why: 'Remember-me path untouched.' },
    { label: 'Minimal', score: 95, why: 'One rename.' },
  ],
  findings: [{ kind: 'risk', text: 'Redirect target is not validated.', file: 'src/a.ts' }],
};

/** A model call the test settles by hand. */
function pendingReply() {
  let resolve: (text: string) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const result = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const cancel = vi.fn(() => reject(new Error('cancelled')));
  mockStartRequest.mockReturnValue({ result, cancel });
  return { resolve, reject, cancel };
}

const task = (): Task => store.tasks.t1;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  setStore('reviewModel', { provider: 'claude', model: 'opus' });
  setStore('reviewGuidance', '');
  setStore('tasks', {
    t1: {
      id: 't1',
      name: 'Fix login',
      projectId: 'p1',
      branchName: 'task/fix',
      worktreePath: '/wt',
      gitIsolation: 'worktree',
      baseBranch: 'main',
      agentIds: ['agent-1'],
      lastPrompt: 'Also keep ?next=',
      promptHistory: [
        { text: 'Fix the redirect', sentAt: 50 },
        { text: 'Also keep ?next=', sentAt: 60 },
      ],
    } as unknown as Task,
  });
  mockLoadTaskDiff.mockResolvedValue({ rawDiff: DIFF, cwd: '/wt' });
});

describe('startTaskReview', () => {
  it('rates the work on the reviewer model from every prompt and the diff', async () => {
    setStore('reviewGuidance', 'Weigh missing tests heavily.');
    setStore('tasks', 't1', 'reviewDismissed', {
      'risk:no real provider.': { text: 'No real provider.', reason: 'CI covers it' },
    });
    mockStartRequest.mockReturnValue({
      result: Promise.resolve(JSON.stringify(RATING)),
      cancel: vi.fn(),
    });
    await startTaskReview('t1');
    const request = mockStartRequest.mock.calls[0][0];
    expect(request).toMatchObject({
      purpose: 'review',
      cwd: '/wt',
      settings: { provider: 'claude', model: 'opus' },
    });
    for (const text of [
      'Fix the redirect',
      'Also keep ?next=',
      '+change',
      'Weigh missing tests heavily.',
      'No real provider. (CI covers it)',
    ])
      expect(request.prompt).toContain(text);
    expect(task().confidence).toMatchObject({
      ...RATING,
      source: 'Review by opus',
      publishedAt: expect.any(Number),
      fingerprint: expect.any(String),
    });
    expect(task().reviewStatus).toBeUndefined();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.stringContaining('“Fix login” is ready'),
      expect.objectContaining({ action: expect.objectContaining({ label: 'Open review' }) }),
    );
  });

  it('asks the reviewer only once the checks started with it have ended', async () => {
    let finishChecks: (results: { name: string; result: string }[]) => void = () => {};
    const checks = new Promise<{ name: string; result: string }[]>(
      (resolve) => (finishChecks = resolve),
    );
    mockStartRequest.mockReturnValue({
      result: Promise.resolve(JSON.stringify(RATING)),
      cancel: vi.fn(),
    });
    const run = startTaskReview('t1', checks);
    await settle();
    expect(mockStartRequest).not.toHaveBeenCalled();
    expect(task().reviewStatus?.state).toBe('running');
    finishChecks([{ name: 'Unit tests', result: 'failed' }]);
    await run;
    expect(mockStartRequest.mock.calls[0][0].prompt).toContain('- Unit tests: failed');
  });

  it('stops without asking the reviewer when cancelled while the checks run', async () => {
    const run = startTaskReview('t1', new Promise(() => {}));
    await settle();
    cancelTaskReview('t1');
    await run;
    expect(mockStartRequest).not.toHaveBeenCalled();
    expect(task().reviewStatus).toBeUndefined();
  });

  it('asks Claude to review at high when no level is chosen, without saving that level', async () => {
    mockStartRequest.mockReturnValue({
      result: Promise.resolve(JSON.stringify(RATING)),
      cancel: vi.fn(),
    });
    await startTaskReview('t1');
    expect(mockStartRequest.mock.calls[0][0].settings).toMatchObject({
      provider: 'claude',
      effort: 'high',
    });
    expect(store.reviewModel).toEqual({ provider: 'claude', model: 'opus' });
  });

  it("runs on the task's own reviewer when it has one", async () => {
    setTaskReviewModel('t1', { provider: 'codex', model: 'gpt-5', effort: 'high' });
    mockStartRequest.mockReturnValue({
      result: Promise.resolve(JSON.stringify(RATING)),
      cancel: vi.fn(),
    });
    await startTaskReview('t1');
    expect(mockStartRequest.mock.calls[0][0].settings).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      effort: 'high',
    });
    expect(task().confidence?.source).toBe('Review by gpt-5');
    // Settings › Review is untouched; it stays the default for other tasks.
    expect(store.reviewModel).toEqual({ provider: 'claude', model: 'opus' });
  });

  it('runs in the background, one review per task', async () => {
    const reply = pendingReply();
    const first = startTaskReview('t1');
    expect(task().reviewStatus).toEqual({ state: 'running', startedAt: expect.any(Number) });
    await settle();
    void startTaskReview('t1');
    await settle();
    expect(mockStartRequest).toHaveBeenCalledTimes(1);
    reply.resolve(JSON.stringify(RATING));
    await first;
    expect(task().reviewStatus).toBeUndefined();
    expect(task().confidence?.scores).toHaveLength(3);
  });

  it('keeps the last rating and says why when the review fails', async () => {
    const old = { scores: [], findings: [], publishedAt: 1 };
    setStore('tasks', 't1', 'confidence', old);
    mockStartRequest.mockReturnValue({
      result: Promise.reject(new Error('claude not found')),
      cancel: vi.fn(),
    });
    await startTaskReview('t1');
    expect(task().reviewStatus).toEqual({ state: 'failed', message: 'claude not found' });
    expect(task().confidence).toEqual(old);
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining('failed: claude not found'));
  });

  it('fails on an answer that is not a rating', async () => {
    mockStartRequest.mockReturnValue({ result: Promise.resolve('Looks good!'), cancel: vi.fn() });
    await startTaskReview('t1');
    expect(task().reviewStatus?.state).toBe('failed');
    expect(task().confidence).toBeUndefined();
  });

  it('writes no rating for a task that closed while the model read', async () => {
    const reply = pendingReply();
    const run = startTaskReview('t1');
    await vi.waitFor(() => expect(mockStartRequest).toHaveBeenCalled());
    // The watcher that also stops the call needs effects, which the client suite covers.
    setStore('tasks', 't1', 'closingStatus', 'closing');
    reply.resolve(JSON.stringify(RATING));
    await run;
    expect(task().reviewStatus).toBeUndefined();
    expect(task().confidence).toBeUndefined();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('can be cancelled, leaving the last rating and no error', async () => {
    const old = { scores: [], findings: [], publishedAt: 1 };
    setStore('tasks', 't1', 'confidence', old);
    const reply = pendingReply();
    const run = startTaskReview('t1');
    await settle();
    cancelTaskReview('t1');
    await run;
    expect(reply.cancel).toHaveBeenCalled();
    expect(task().reviewStatus).toBeUndefined();
    expect(task().confidence).toEqual(old);
    expect(mockNotify).not.toHaveBeenCalled();
    // A cancelled review frees the task for the next one.
    mockStartRequest.mockReturnValue({
      result: Promise.resolve(JSON.stringify(RATING)),
      cancel: vi.fn(),
    });
    await startTaskReview('t1');
    expect(task().confidence?.scores).toHaveLength(3);
  });
});
