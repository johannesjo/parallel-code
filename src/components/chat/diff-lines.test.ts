import { describe, expect, it } from 'vitest';
import { parseDiff } from './diff-lines';

describe('diff lines', () => {
  it('numbers lines from their hunk headers', () => {
    expect(parseDiff('@@ -3,2 +3,2 @@\n x\n-a\n+b\n\\ No newline at end of file')).toEqual([
      { kind: 'hunk', text: '@@ -3,2 +3,2 @@' },
      { kind: 'context', text: 'x', old: 3, new: 3 },
      { kind: 'del', text: 'a', old: 4 },
      { kind: 'add', text: 'b', new: 4 },
      { kind: 'note', text: '\\ No newline at end of file' },
    ]);
  });

  it('leaves a proposed edit, which has no hunk header, unnumbered', () => {
    expect(parseDiff('-a\n+b')).toEqual([
      { kind: 'del', text: 'a', old: undefined },
      { kind: 'add', text: 'b', new: undefined },
    ]);
  });
});
