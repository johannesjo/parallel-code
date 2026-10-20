import { describe, expect, it } from 'vitest';
import { hunksDiff, replacementDiff, unifiedDiff, wholeFileDiff } from './chat-diffs.js';

describe('chat diffs', () => {
  it('shows a created file as added lines and caps a long one', () => {
    expect(wholeFileDiff('a.ts', 'one\ntwo\n', '+').diff).toBe('@@ -0,0 +1,2 @@\n+one\n+two');
    const long = wholeFileDiff('big.ts', 'x\n'.repeat(1000), '+').diff.split('\n');
    expect(long).toHaveLength(401);
    expect(long[long.length - 1]).toBe('… 601 more lines');
    // The totals count the lines the cap hides.
    expect(wholeFileDiff('big.ts', 'x\n'.repeat(1000), '+')).toMatchObject({
      added: 1000,
      removed: 0,
    });
  });

  it('shows an empty replacement side as nothing rather than a blank line', () => {
    expect(replacementDiff('a.ts', [{ before: '', after: 'added' }]).diff).toBe('+added');
  });

  it('parts several replacements and caps them together', () => {
    const edit = { before: 'a', after: 'b' };
    expect(replacementDiff('a.ts', [edit, edit]).diff).toBe('-a\n+b\n⋯\n-a\n+b');
    const many = replacementDiff(
      'a.ts',
      Array.from({ length: 300 }, () => edit),
    );
    expect(many.diff.split('\n')).toHaveLength(401);
    expect(many).toMatchObject({ added: 300, removed: 300 });
  });

  it('accepts only a well-formed structured patch', () => {
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] };
    expect(hunksDiff('a.ts', [hunk])?.diff).toBe('@@ -1,1 +1,1 @@\n-a\n+b');
    expect(hunksDiff('a.ts', [])).toBeUndefined();
    expect(hunksDiff('a.ts', [{ ...hunk, lines: [1] }])).toBeUndefined();
    expect(hunksDiff('a.ts', 'patch')).toBeUndefined();
  });

  it('drops the file headers of a unified diff', () => {
    expect(unifiedDiff('a.ts', 'diff --git a b\n--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n').diff).toBe(
      '@@ -1 +1 @@\n-a\n+b',
    );
  });
});
