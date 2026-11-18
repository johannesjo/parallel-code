import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLoadTaskDiff } = vi.hoisted(() => ({ mockLoadTaskDiff: vi.fn() }));

vi.mock('../lib/load-task-diff', () => ({
  loadTaskDiff: mockLoadTaskDiff,
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
}));
vi.mock('./projects', () => ({ getProjectPath: () => '/repo' }));

import { diffFingerprint } from '../lib/diff-excerpt';
import { publishTaskConfidence, taskConfidence } from './confidence';
import { store, setStore } from './core';
import type { Task } from './types';
import { noteCodeFingerprint, promptsSince, refreshCodeFingerprint } from './task-diff';

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+change';

function task(): Task {
  return store.tasks.t1;
}

beforeEach(() => {
  vi.clearAllMocks();
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
      savedInitialPrompt: 'Fix the redirect',
      promptHistory: [
        { text: 'Also the logout', sentAt: 200 },
        { text: 'Fix the redirect', sentAt: 50 },
      ],
    } as unknown as Task,
  });
  mockLoadTaskDiff.mockResolvedValue({ rawDiff: DIFF, cwd: '/wt' });
});

describe('refreshCodeFingerprint', () => {
  it('records the fingerprint of the code it read', async () => {
    await refreshCodeFingerprint('t1');
    expect(task().codeFingerprint?.fingerprint).toBe(diffFingerprint(DIFF));
  });

  it('does not mistake an unreadable diff for no changes', async () => {
    mockLoadTaskDiff.mockRejectedValue(new Error('git failed'));
    await refreshCodeFingerprint('t1');
    expect(task().codeFingerprint).toBeUndefined();
  });

  it('leaves a closing task alone', async () => {
    setStore('tasks', 't1', 'closingStatus', 'closing');
    await refreshCodeFingerprint('t1');
    expect(mockLoadTaskDiff).not.toHaveBeenCalled();
  });
});

describe('noteCodeFingerprint', () => {
  it('keeps the newer reading when an older one arrives late', () => {
    noteCodeFingerprint('t1', 'new', 2_000);
    noteCodeFingerprint('t1', 'old', 1_000);
    expect(task().codeFingerprint).toEqual({ fingerprint: 'new', at: 2_000 });
  });
});

describe('promptsSince', () => {
  it('lists the prompts sent after a time, or the starting prompt when none are dated', () => {
    expect(promptsSince(task(), 0)).toEqual(['Also the logout', 'Fix the redirect']);
    expect(promptsSince(task(), 100)).toEqual(['Also the logout']);
    expect(promptsSince(task(), 300)).toEqual([]);
    setStore('tasks', 't1', 'promptHistory', []);
    expect(promptsSince(task(), 0)).toEqual(['Fix the redirect']);
  });
});

describe('publishTaskConfidence', () => {
  it('stores a published rating with the fingerprint of the code it rated', async () => {
    publishTaskConfidence('t1', { scores: [{ label: 'Confidence', score: 70, why: 'x' }] });
    expect(taskConfidence(task())).toMatchObject({ scores: [{ score: 70 }], findings: [] });
    await vi.waitFor(() => expect(taskConfidence(task())?.fingerprint).toBe(diffFingerprint(DIFF)));
    // The agent's own rating replaces a review whole, so it never inherits the reviewer's mark.
    setStore('tasks', 't1', 'cards', 'confidence', 'origin', 'review');
    setStore('tasks', 't1', 'cards', 'confidence', 'headSha', 'abc');
    publishTaskConfidence('t1', { scores: [{ label: 'Confidence', score: 90, why: 'x' }] });
    expect(task().cards?.confidence).not.toHaveProperty('origin');
    expect(task().cards?.confidence).not.toHaveProperty('headSha');
    expect(() => publishTaskConfidence('t1', { scores: [] })).toThrow('scores must be');
    expect(() =>
      publishTaskConfidence('missing', { scores: [{ label: 'C', score: 1, why: 'x' }] }),
    ).toThrow('Task not available');
  });
});
