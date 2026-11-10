import { describe, expect, it } from 'vitest';
import type { Task } from '../store/types';
import { needsEarlyBrief, restoreTaskAgentPlan, taskGoal } from './task-plan';

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

describe('needsEarlyBrief', () => {
  const base = { id: 't1', agentIds: [] } as unknown as Task;
  const long =
    'I was thinking about how we could best improve our general setup, including GitHub replies';

  it('asks for a brief before the first turn ends when the prompt is too long to read as a goal', () => {
    expect(needsEarlyBrief({ ...base, savedInitialPrompt: long })).toBe(true);
  });

  it('leaves short prompts and tasks that already have a brief alone', () => {
    expect(needsEarlyBrief({ ...base, savedInitialPrompt: 'Fix the login redirect' })).toBe(false);
    expect(needsEarlyBrief(base)).toBe(false);
    const brief = { brief: { goal: 'Improve setup', now: '' }, generatedAt: 1, fingerprint: '' };
    expect(needsEarlyBrief({ ...base, brief, savedInitialPrompt: long })).toBe(false);
  });
});
