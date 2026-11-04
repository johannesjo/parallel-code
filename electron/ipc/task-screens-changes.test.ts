import { describe, expect, it } from 'vitest';
import { changedFilesNote, worktreeStatus } from './task-screens-changes.js';

const lines = (...entries: string[]) => new Set(entries);

describe('changedFilesNote', () => {
  it('names only the files that changed while serving', () => {
    const before = lines(' M src/app.ts');
    const after = lines(' M src/app.ts', '?? next-env.d.ts');
    expect(changedFilesNote(before, after)).toBe(
      'Starting the app changed files in the task: next-env.d.ts.',
    );
    expect(changedFilesNote(before, before)).toBeUndefined();
  });

  it('names three files and counts the rest', () => {
    const after = lines('?? a', '?? b', '?? c', '?? d', '?? e');
    expect(changedFilesNote(lines(), after)).toBe(
      'Starting the app changed files in the task: a, b, c and 2 more.',
    );
  });

  it('says nothing when a status could not be read', () => {
    expect(changedFilesNote(undefined, lines('?? a'))).toBeUndefined();
  });
});

describe('worktreeStatus', () => {
  it('reads nothing, instead of failing the capture, outside a repository', async () => {
    expect(await worktreeStatus('/nonexistent-pc-screens-dir')).toBeUndefined();
  });
});
