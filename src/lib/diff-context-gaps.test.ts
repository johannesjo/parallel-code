import { describe, expect, it, vi } from 'vitest';

import { getContextGapLineCount, revealCitedContext } from './diff-context-gaps';
import type { FileDiff } from './unified-diff-parser';

describe('getContextGapLineCount', () => {
  it('counts bounded hidden context lines', () => {
    expect(getContextGapLineCount({ startLine: 3, endLine: 8, oldLineStart: 3 })).toBe(5);
  });

  it('does not return negative counts for touching or overlapping hunks', () => {
    expect(getContextGapLineCount({ startLine: 8, endLine: 8, oldLineStart: 8 })).toBe(0);
    expect(getContextGapLineCount({ startLine: 9, endLine: 8, oldLineStart: 9 })).toBe(0);
  });

  it('returns null for trailing gaps that need file content inspection', () => {
    expect(getContextGapLineCount({ startLine: 8, oldLineStart: 8 })).toBeNull();
  });
});

it('reveals only nearby unchanged lines and maps them past an earlier edit', async () => {
  const file: FileDiff = {
    path: 'a.ts',
    status: 'M',
    binary: false,
    hunks: [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 4, lines: [] }],
  };
  const read = vi.fn(
    async () => Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n') + '\n',
  );
  await revealCitedContext(file, 3, read);
  expect(read).not.toHaveBeenCalled();
  await revealCitedContext(file, 19, read);
  expect(file.hunks[1]).toMatchObject({ newStart: 16, oldStart: 14, newCount: 5, oldCount: 5 });
  expect(file.hunks[1].lines[3]).toEqual({
    type: 'context',
    content: 'Line 19',
    oldLine: 17,
    newLine: 19,
  });
});
