import { createEffect, createRoot, on } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStartRequest } = vi.hoisted(() => ({ mockStartRequest: vi.fn() }));

vi.mock('../lib/model-request', () => ({ startModelRequest: mockStartRequest }));
vi.mock('../lib/load-task-diff', () => ({
  loadTaskDiff: () => Promise.resolve({ rawDiff: '+change', cwd: '/wt' }),
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
}));
vi.mock('./notification', () => ({ showNotification: vi.fn(), NOTIFICATION_ERROR_MS: 10_000 }));
vi.mock('./tasks', () => ({ sendPrompt: vi.fn(), uncollapseTask: vi.fn() }));
vi.mock('./projects', () => ({ getProjectPath: () => '/repo' }));

import { store, setStore } from './core';
import { showNotification } from './notification';
import { uncollapseTask } from './tasks';
import type { Task } from './types';
import { openTaskReview, startTaskReview, takeUnseenReview } from './task-review';

beforeEach(() => {
  vi.mocked(showNotification).mockClear();
  setStore('finishReview', true);
  setStore('pendingAction', null);
  setStore('activeTaskId', null);
  setStore('tasks', {
    t1: {
      id: 't1',
      name: 'Fix login',
      projectId: 'p1',
      branchName: 'task/fix',
      worktreePath: '/wt',
      gitIsolation: 'worktree',
      agentIds: ['agent-1'],
      lastPrompt: 'Fix the redirect',
    } as unknown as Task,
  });
});

describe('startTaskReview', () => {
  it('stops the model call as soon as the task closes', async () => {
    let reject: (error: Error) => void = () => {};
    const cancel = vi.fn(() => reject(new Error('cancelled')));
    mockStartRequest.mockReturnValue({
      result: new Promise<string>((_, rej) => (reject = rej)),
      cancel,
    });
    const run = startTaskReview('t1');
    await vi.waitFor(() => expect(mockStartRequest).toHaveBeenCalled());
    setStore('tasks', 't1', 'closingStatus', 'closing');
    await run;
    expect(cancel).toHaveBeenCalled();
    expect(store.tasks.t1.reviewStatus).toBeUndefined();
  });
});

describe('a review that finishes in the background', () => {
  const finishReview = async () => {
    mockStartRequest.mockReturnValue({
      result: Promise.resolve(
        JSON.stringify({
          scores: [{ label: 'Correctness', score: 90, why: 'Tested.' }],
          findings: [],
        }),
      ),
      cancel: vi.fn(),
    });
    await startTaskReview('t1');
  };
  const notified = () => vi.mocked(showNotification).mock.calls.at(-1)?.[1];

  it('offers to open the review, which then opens unfolded once', async () => {
    await finishReview();
    const action = notified()?.action;
    expect(action?.label).toBe('Open review');
    action?.run();
    expect(store.pendingAction).toEqual({ type: 'finish', taskId: 't1' });
    expect(takeUnseenReview('t1')).toBe(true);
    expect(takeUnseenReview('t1')).toBe(false);
  });

  it('counts a review watched as it finished as seen', async () => {
    // Stands in for an open review section, which takes the flag as the run ends.
    const dispose = createRoot((dispose) => {
      createEffect(
        on(
          () => store.tasks.t1?.reviewStatus?.state === 'running',
          (now, was) => {
            if (was && !now) takeUnseenReview('t1');
          },
        ),
      );
      return dispose;
    });
    await finishReview();
    dispose();
    expect(takeUnseenReview('t1')).toBe(false);
    // Already on screen, so the notice has nothing to open.
    expect(notified()?.action).toBeUndefined();
  });

  it('relabels the button when the task is collapsed while the notice is up', async () => {
    await finishReview();
    setStore('tasks', 't1', 'collapsed', true);
    expect(notified()?.action?.label).toBe('Resume and open review');
  });

  it('says that opening a collapsed task resumes it', async () => {
    setStore('tasks', 't1', 'collapsed', true);
    await finishReview();
    expect(notified()?.action?.label).toBe('Resume and open review');
  });

  it('brings a collapsed task back before opening Finish', () => {
    setStore('tasks', 't1', 'collapsed', true);
    openTaskReview('t1');
    expect(uncollapseTask).toHaveBeenCalledWith('t1');
    expect(store.activeTaskId).toBe('t1');
    expect(store.pendingAction).toEqual({ type: 'finish', taskId: 't1' });
  });

  it('offers no button on a task Finish cannot open', async () => {
    setStore('tasks', 't1', 'gitIsolation', 'direct');
    await finishReview();
    expect(notified()?.action).toBeUndefined();
  });

  it('does nothing once the task is gone', () => {
    setStore('tasks', 't1', undefined as unknown as Task);
    openTaskReview('t1');
    expect(store.pendingAction).toBeNull();
  });

  it('offers no button when reviews are not shown in Finish', async () => {
    setStore('finishReview', false);
    await finishReview();
    expect(notified()?.action).toBeUndefined();
  });
});
