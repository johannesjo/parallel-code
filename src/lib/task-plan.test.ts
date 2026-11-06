import { describe, expect, it } from 'vitest';
import type { Task } from '../store/types';
import { restoreTaskAgentPlan, taskGoal } from './task-plan';

describe('restoreTaskAgentPlan', () => {
  it('keeps a well-formed plan and drops malformed ones', () => {
    const plan = { steps: [{ step: 'Commit', status: 'pending' }], updatedAt: 3 };
    expect(restoreTaskAgentPlan(plan)).toEqual(plan);
    expect(restoreTaskAgentPlan({ ...plan, failedCommand: 7 })).toEqual(plan);
    expect(restoreTaskAgentPlan({ steps: [{ step: 'x', status: 'done' }], updatedAt: 1 })).toBe(
      undefined,
    );
    expect(restoreTaskAgentPlan({ steps: [] })).toBeUndefined();
    expect(restoreTaskAgentPlan('plan')).toBeUndefined();
  });
});

describe('taskGoal', () => {
  const base = { id: 't1', agentIds: [] } as unknown as Task;

  it("uses the brief's goal first", () => {
    const brief = { brief: { goal: 'Document setup', now: '' }, generatedAt: 1, fingerprint: '' };
    expect(taskGoal({ ...base, brief, savedInitialPrompt: 'Ignored' })).toBe('Document setup');
  });

  it("falls back to the first line of the task's prompt, shortened", () => {
    expect(taskGoal({ ...base, savedInitialPrompt: '\n  Fix   the login\nmore detail' })).toBe(
      'Fix the login',
    );
    const long = 'word '.repeat(80);
    expect(taskGoal({ ...base, promptHistory: [{ text: long }] })).toHaveLength(200);
    expect(taskGoal(base)).toBe('');
  });
});
