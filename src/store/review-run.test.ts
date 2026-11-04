import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockBuild, mockReview, mockStop, mockCancel } = vi.hoisted(() => ({
  mockBuild: vi.fn(() => Promise.resolve()),
  mockReview: vi.fn(() => Promise.resolve()),
  mockStop: vi.fn(() => Promise.resolve()),
  mockCancel: vi.fn(),
}));

vi.mock('./check-suite', () => ({ runCheckSuite: mockBuild, stopCheckSuite: mockStop }));
vi.mock('./task-review', () => ({ startTaskReview: mockReview, cancelTaskReview: mockCancel }));

import { setStore, store } from './core';
import type { Project, Task } from './types';
import { cancelReview, setReviewChecks, startReview } from './review-run';

function setup(reviewChecks: string[] | undefined, task: Partial<Task> = {}) {
  setStore('projects', [
    {
      id: 'p1',
      name: 'Weather',
      path: '/repo',
      color: '#fff',
      verifyCommand: 'npm run check',
      evidenceChecks: [{ id: 'e2e', name: 'E2E', kind: 'e2e', command: 'e2e', run: 'on-demand' }],
      reviewChecks,
    } as Project,
  ]);
  setStore('tasks', { t1: { id: 't1', projectId: 'p1', ...task } as Task });
}

beforeEach(() => vi.clearAllMocks());

describe('startReview', () => {
  it('runs the picked checks that still exist and hands the reviewer how they ended', async () => {
    setup(['e2e', 'verify', 'removed']);
    mockBuild.mockImplementationOnce(() => {
      setStore('tasks', 't1', 'evidence', {
        id: 'new',
        checks: [
          { checkId: 'e2e', name: 'E2E', status: 'failed' },
          { checkId: 'other', name: 'Other', status: 'passed' },
        ],
        skipped: [{ checkId: 'verify', name: 'Verify', reason: 'dirty' }],
      } as unknown as Task['evidence']);
      return Promise.resolve();
    });
    startReview('t1');
    expect(mockBuild).toHaveBeenCalledWith('t1', { only: ['verify', 'e2e'] });
    const checks = (mockReview.mock.calls[0] as unknown[])[1] as Promise<unknown>;
    await expect(checks).resolves.toEqual([
      { name: 'E2E', result: 'failed' },
      { name: 'Verify', result: 'skipped: dirty' },
    ]);
  });

  it('hands the reviewer no results when the build made no package, not older ones', async () => {
    setup(['e2e'], {
      evidence: {
        id: 'old',
        checks: [{ checkId: 'e2e', name: 'E2E', status: 'passed' }],
        skipped: [],
      } as unknown as Task['evidence'],
    });
    startReview('t1');
    const checks = (mockReview.mock.calls[0] as unknown[])[1] as Promise<unknown>;
    await expect(checks).resolves.toEqual([]);
  });

  it('still reviews when the checks fail to run, saying none ran', async () => {
    setup(['e2e']);
    mockBuild.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    startReview('t1');
    const checks = (mockReview.mock.calls[0] as unknown[])[1] as Promise<unknown>;
    await expect(checks).resolves.toEqual([]);
  });

  it('runs the reviewer alone when nothing is picked', () => {
    setup([]);
    startReview('t1');
    expect(mockBuild).not.toHaveBeenCalled();
    expect(mockReview).toHaveBeenCalledWith('t1', undefined);
  });

  it('starts nothing while a review runs', () => {
    setup(['verify'], { reviewStatus: { state: 'running', startedAt: 1 } });
    startReview('t1');
    expect(mockBuild).not.toHaveBeenCalled();
    expect(mockReview).not.toHaveBeenCalled();
  });
});

describe('cancelReview', () => {
  it('stops the check run along with the reviewer', () => {
    setup(['e2e'], { evidence: { assembling: true, checks: [] } as never });
    cancelReview('t1');
    expect(mockCancel).toHaveBeenCalledWith('t1');
    expect(mockStop).toHaveBeenCalledWith('t1');
  });

  it('leaves finished checks alone', () => {
    setup(['e2e'], { evidence: { assembling: false, checks: [] } as never });
    cancelReview('t1');
    expect(mockCancel).toHaveBeenCalledWith('t1');
    expect(mockStop).not.toHaveBeenCalled();
  });
});

describe('setReviewChecks', () => {
  it('saves the pick on the task project', () => {
    setup(undefined);
    setReviewChecks('t1', { ids: ['verify'] });
    expect(store.projects[0].reviewChecks).toEqual(['verify']);
    expect(store.projects[0].evidenceChecks).toHaveLength(1);
  });

  it('adds the suggested checks the user picked, keeping a verify command already set', () => {
    setup(undefined);
    const lint = {
      id: 'static-checks',
      name: 'Static checks',
      kind: 'static',
      command: 'npm run lint',
      run: 'auto',
    } as const;
    setReviewChecks('t1', {
      ids: ['static-checks'],
      newChecks: [lint],
      verifyCommand: 'make check',
    });
    expect(store.projects[0].evidenceChecks?.map((check) => check.id)).toEqual([
      'e2e',
      'static-checks',
    ]);
    expect(store.projects[0].verifyCommand).toBe('npm run check');
    setStore('projects', 0, 'verifyCommand', undefined);
    setReviewChecks('t1', { ids: ['verify'], verifyCommand: 'make check' });
    expect(store.projects[0].verifyCommand).toBe('make check');
  });
});
