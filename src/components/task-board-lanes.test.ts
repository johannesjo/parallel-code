import { describe, expect, it } from 'vitest';
import type { Task } from '../store/types';
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
