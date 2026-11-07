import { describe, expect, it } from 'vitest';
import type { PrChecksState } from '../store/pr-checks-state';
import type { Task } from '../store/types';
import { pullRequestsLane } from '../store/pr-checks-state';
import { groupSubtasks, headingParentAt } from './task-board-lanes';

const task = (id: string, coordinatedBy?: string) => ({ id, coordinatedBy }) as Task;
const ids = (tasks: Task[]) => tasks.map((t) => t.id);

describe('groupSubtasks', () => {
  it('puts subtasks right after their coordinator', () => {
    const tasks = [task('a1', 'p'), task('x'), task('p'), task('a2', 'p')];
    expect(ids(groupSubtasks(tasks))).toEqual(['p', 'a1', 'a2', 'x']);
  });

  it('keeps siblings together when their coordinator is in another lane', () => {
    const tasks = [task('a1', 'p'), task('x'), task('a2', 'p')];
    expect(ids(groupSubtasks(tasks))).toEqual(['a1', 'a2', 'x']);
  });

  it('leaves unrelated tasks in order', () => {
    const tasks = [task('x'), task('y'), task('z')];
    expect(ids(groupSubtasks(tasks))).toEqual(['x', 'y', 'z']);
  });
});

describe('headingParentAt', () => {
  const lane = [task('x'), task('a1', 'p'), task('a2', 'p'), task('p'), task('b1', 'p')];
  it('names the coordinator where a block of its subtasks starts away from it', () => {
    expect(lane.map((_, i) => headingParentAt(lane, i))).toEqual([
      undefined,
      'p',
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('names the coordinator above a subtask at the top of the lane', () => {
    expect(headingParentAt([task('a1', 'p')], 0)).toBe('p');
  });
});

describe('pullRequestsLane', () => {
  const checks = (overrides: Partial<PrChecksState> = {}): PrChecksState => ({
    overall: 'success',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    passing: 1,
    pending: 0,
    failing: 0,
    checks: [],
    checkedAt: '2026-11-05T00:00:00Z',
    ...overrides,
  });
  const merged = checks({ merged: true });
  const running = checks({ overall: 'pending' });
  const failed = checks({ overall: 'failure' });

  it('stays in pull request while one PR is open after another merged', () => {
    expect(pullRequestsLane([merged, running], false)).toBe('pr');
  });

  it('stays in pull request once every PR merged', () => {
    expect(pullRequestsLane([merged, merged], false)).toBe('pr');
  });

  it('is ready only when every open PR is', () => {
    expect(pullRequestsLane([merged, checks()], false)).toBe('ready');
    expect(pullRequestsLane([checks(), running], false)).toBe('pr');
    expect(pullRequestsLane([checks(), undefined], false)).toBe('pr');
  });

  it('needs you when any open PR fails and Babysit is not on it', () => {
    expect(pullRequestsLane([running, failed], false)).toBe('needs');
    expect(pullRequestsLane([running, failed], true)).toBe('pr');
    expect(pullRequestsLane([failed, merged], false)).toBe('needs');
  });

  it('needs you when any open PR has conflicts Babysit is not on, or requested changes', () => {
    const conflicting = checks({ overall: 'failure', mergeable: 'CONFLICTING' });
    expect(pullRequestsLane([running, conflicting], false)).toBe('needs');
    // Babysit sends conflicts to the agent as it does CI failures.
    expect(pullRequestsLane([running, conflicting], true)).toBe('pr');
    expect(pullRequestsLane([checks({ mergeable: 'CONFLICTING' })], true)).toBe('needs');
    // Babysit sends the conflict once the running checks finish, so it stays put meanwhile.
    const conflictingRunning = checks({ overall: 'pending', mergeable: 'CONFLICTING' });
    expect(pullRequestsLane([conflictingRunning], true)).toBe('pr');
    expect(pullRequestsLane([conflictingRunning], false)).toBe('needs');
    expect(pullRequestsLane([checks({ reviewDecision: 'CHANGES_REQUESTED' })], true)).toBe('needs');
  });
});
