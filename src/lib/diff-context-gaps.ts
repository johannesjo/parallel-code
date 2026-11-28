import type { FileDiff, Hunk } from './unified-diff-parser';

export interface ContextGapRange {
  startLine: number;
  oldLineStart: number;
  endLine?: number;
}

export function getContextGapLineCount(range: ContextGapRange): number | null {
  if (range.endLine === undefined) return null;
  return Math.max(0, range.endLine - range.startLine);
}

/** Show a cited worktree line with three lines of surrounding diff context,
 * without unfolding a potentially large gap. */
export async function revealCitedContext(
  file: FileDiff,
  line: number,
  readSource: () => Promise<string>,
): Promise<void> {
  if (file.binary || file.status !== 'M' || !Number.isSafeInteger(line) || line < 1) return;
  const nextIndex = file.hunks.findIndex((hunk) => hunk.newStart > line);
  const index = nextIndex < 0 ? file.hunks.length : nextIndex;
  const previous = file.hunks[index - 1];
  const gapStart = previous ? previous.newStart + previous.newCount : 1;
  if (line < gapStart) return;

  const source = (await readSource()).split('\n');
  if (source.at(-1) === '') source.pop();
  if (line > source.length) return;
  const start = Math.max(gapStart, line - 3);
  const end = Math.min(line + 3, (file.hunks[index]?.newStart ?? Infinity) - 1, source.length);
  const oldStart = (previous ? previous.oldStart + previous.oldCount : 1) + start - gapStart;
  const lines: Hunk['lines'] = source.slice(start - 1, end).map((content, offset) => ({
    type: 'context',
    content,
    oldLine: oldStart + offset,
    newLine: start + offset,
  }));
  file.hunks.splice(index, 0, {
    newStart: start,
    oldStart,
    oldCount: lines.length,
    newCount: lines.length,
    lines,
  });
}
