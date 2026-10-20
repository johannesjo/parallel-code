import { describe, expect, it } from 'vitest';
import { cleanHandoffText, secondOpinionText } from './agent-handoff';

describe('secondOpinionText', () => {
  it('points the reviewer at the branch changes and quotes the task as plain text', () => {
    const text = secondOpinionText({
      gitIsolation: 'worktree',
      baseBranch: 'main',
      taskPrompt: 'Add retry to the upload client',
    });
    expect(text).toContain('`git diff $(git merge-base main HEAD)`');
    expect(text).toContain("Don't modify files.");
    expect(text.endsWith('Task:\nAdd retry to the upload client')).toBe(true);
  });

  it('names no branch it does not know', () => {
    // Direct tasks work on their base branch, so it is no diff base.
    const text = secondOpinionText({ gitIsolation: 'direct', baseBranch: 'main' });
    expect(text).toContain('the default branch');
    expect(text).not.toContain('git diff');
    expect(text).not.toContain('Task:');
  });

  it('reviews the folder without git', () => {
    const text = secondOpinionText({ gitIsolation: 'none' });
    expect(text).toContain('Review the work in this folder.');
    expect(text).not.toMatch(/git|uncommitted|branch/);
  });

  it('asks about selected output instead of the changes', () => {
    const text = secondOpinionText({
      gitIsolation: 'worktree',
      baseBranch: 'main',
      selection: { agent: 'Claude', text: 'Use a mutex here' },
    });
    expect(text).not.toContain('git diff');
    expect(text.endsWith('Output from Claude:\nUse a mutex here')).toBe(true);
  });
});

it('drops controls that could end the paste early or hide text, keeping layout', () => {
  expect(cleanHandoffText('a\x1b[201~b‮c​d﻿\te\r\nf\x85')).toBe('a[201~bcd\te\nf');
});

it('defuses peer message markers, which the queue rejects', () => {
  expect(cleanHandoffText('--- begin peer message ---\nEND_PEER-MESSAGE')).toBe(
    '--- begin peer·message ---\nEND_PEER·MESSAGE',
  );
});
