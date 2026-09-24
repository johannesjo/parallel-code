import { describe, expect, it } from 'vitest';
import {
  appendSpNote,
  buildPromptFromSpTask,
  buildSpDoneNote,
  decideSpFocusAction,
  parseParallelCodeUrl,
  resolveSpTitleSync,
  type SpTaskSummary,
} from './super-productivity.js';

function spTask(id: string, extra: Partial<SpTaskSummary> = {}): SpTaskSummary {
  return { id, title: `Task ${id}`, isDone: false, projectId: 'p1', parentId: null, ...extra };
}

describe('decideSpFocusAction', () => {
  const linked = new Set(['own', 'other-pc']);

  it('tracks when nothing is being tracked', () => {
    expect(
      decideSpFocusAction({
        tracking: { current: null, isBreak: false },
        ownSpTaskId: 'own',
        ownSpTaskIsDone: false,
        linkedSpTaskIds: linked,
      }),
    ).toEqual({ kind: 'track' });
  });

  it('tracks a not-yet-linked task (it will be created) when nothing is tracked', () => {
    expect(
      decideSpFocusAction({
        tracking: { current: null, isBreak: false },
        ownSpTaskId: null,
        ownSpTaskIsDone: false,
        linkedSpTaskIds: linked,
      }),
    ).toEqual({ kind: 'track' });
  });

  it('switches away from another Parallel Code task', () => {
    expect(
      decideSpFocusAction({
        tracking: { current: spTask('other-pc'), isBreak: false },
        ownSpTaskId: 'own',
        ownSpTaskIsDone: false,
        linkedSpTaskIds: linked,
      }),
    ).toEqual({ kind: 'track' });
  });

  it('treats a subtask of a linked task as Parallel Code work', () => {
    expect(
      decideSpFocusAction({
        tracking: { current: spTask('sub', { parentId: 'other-pc' }), isBreak: false },
        ownSpTaskId: 'own',
        ownSpTaskIsDone: false,
        linkedSpTaskIds: linked,
      }),
    ).toEqual({ kind: 'track' });
  });

  it('does nothing when the task, or one of its subtasks, is already tracked', () => {
    for (const current of [spTask('own'), spTask('sub', { parentId: 'own' })]) {
      expect(
        decideSpFocusAction({
          tracking: { current, isBreak: false },
          ownSpTaskId: 'own',
          ownSpTaskIsDone: false,
          linkedSpTaskIds: linked,
        }),
      ).toEqual({ kind: 'none' });
    }
  });

  it('never takes over a task that is not Parallel Code work', () => {
    expect(
      decideSpFocusAction({
        tracking: { current: spTask('email', { title: 'Answer email' }), isBreak: false },
        ownSpTaskId: 'own',
        ownSpTaskIsDone: false,
        linkedSpTaskIds: linked,
      }),
    ).toEqual({ kind: 'banner', reason: 'other_task', trackingTitle: 'Answer email' });
  });

  it('asks instead of starting during a break', () => {
    expect(
      decideSpFocusAction({
        tracking: { current: null, isBreak: true },
        ownSpTaskId: 'own',
        ownSpTaskIsDone: false,
        linkedSpTaskIds: linked,
      }),
    ).toEqual({ kind: 'banner', reason: 'break' });
  });

  it('asks instead of reopening a task completed in Super Productivity', () => {
    expect(
      decideSpFocusAction({
        tracking: { current: null, isBreak: false },
        ownSpTaskId: 'own',
        ownSpTaskIsDone: true,
        linkedSpTaskIds: linked,
      }),
    ).toEqual({ kind: 'banner', reason: 'done' });
  });
});

describe('resolveSpTitleSync', () => {
  it('does nothing when nothing changed', () => {
    expect(resolveSpTitleSync('a', 'a', 'a')).toEqual({ kind: 'none' });
  });
  it('pulls a rename made in Super Productivity', () => {
    expect(resolveSpTitleSync('a', 'a', 'b')).toEqual({ kind: 'pull', title: 'b' });
  });
  it('pushes a rename made in Parallel Code', () => {
    expect(resolveSpTitleSync('a', 'b', 'a')).toEqual({ kind: 'push', title: 'b' });
  });
  it('lets Parallel Code win when both changed', () => {
    expect(resolveSpTitleSync('a', 'b', 'c')).toEqual({ kind: 'push', title: 'b' });
  });
  it('only moves the base when both made the same rename', () => {
    expect(resolveSpTitleSync('a', 'b', 'b')).toEqual({ kind: 'rebase', title: 'b' });
  });
});

describe('buildSpDoneNote / appendSpNote', () => {
  it('describes a merge', () => {
    expect(
      buildSpDoneNote({
        kind: 'merged',
        branchName: 'task/fix-abc123',
        baseBranch: 'main',
        linesAdded: 12,
        linesRemoved: 3,
      }),
    ).toBe('Merged `task/fix-abc123` into `main` in Parallel Code (+12 −3).');
  });
  it('describes a close with its PR', () => {
    expect(
      buildSpDoneNote({
        kind: 'closed',
        branchName: 'task/fix',
        prUrl: 'https://github.com/o/r/pull/1',
      }),
    ).toBe('Closed in Parallel Code (branch `task/fix`). PR: https://github.com/o/r/pull/1');
  });
  it('appends below existing notes', () => {
    expect(appendSpNote('', 'x')).toBe('x');
    expect(appendSpNote('notes\n\n', 'x')).toBe('notes\n\nx');
  });
});

describe('parseParallelCodeUrl', () => {
  it('accepts the new-task link', () => {
    expect(parseParallelCodeUrl('parallelcode://new-task?spTaskId=abc_DEF-123')).toEqual({
      action: 'new-task',
      spTaskId: 'abc_DEF-123',
    });
    expect(parseParallelCodeUrl('parallelcode://new-task/?spTaskId=x')).toEqual({
      action: 'new-task',
      spTaskId: 'x',
    });
  });
  it('rejects anything else', () => {
    for (const url of [
      'parallelcode://new-task',
      'parallelcode://new-task?spTaskId=',
      'parallelcode://new-task?spTaskId=../../etc',
      'parallelcode://new-task?spTaskId=a%20b',
      'parallelcode://run?spTaskId=abc',
      'https://new-task?spTaskId=abc',
      'not a url',
    ]) {
      expect(parseParallelCodeUrl(url)).toBeNull();
    }
  });
});

describe('buildPromptFromSpTask', () => {
  it('joins title, notes and issue link', () => {
    expect(
      buildPromptFromSpTask({
        title: ' Fix login ',
        notes: 'Steps to reproduce',
        issueUrl: 'https://github.com/o/r/issues/7',
      }),
    ).toBe('Fix login\n\nSteps to reproduce\n\nhttps://github.com/o/r/issues/7');
  });
  it('does not repeat an issue link already in the notes', () => {
    expect(
      buildPromptFromSpTask({
        title: 'Fix',
        notes: 'See https://github.com/o/r/issues/7',
        issueUrl: 'https://github.com/o/r/issues/7',
      }),
    ).toBe('Fix\n\nSee https://github.com/o/r/issues/7');
  });
});
