import type { FileDiff, Hunk } from './unified-diff-parser';
import type { ReviewAnnotation } from '../components/review-types';

/** Check whether a hunk modifies any lines in [startLine, endLine] (new-file numbers). */
function hunkTouchesRange(hunk: Hunk, startLine: number, endLine: number): boolean {
  const hunkNewEnd = hunk.newStart + hunk.newCount - 1;
  return hunk.lines.some((line) => {
    if (line.type === 'add') {
      return line.newLine !== null && line.newLine >= startLine && line.newLine <= endLine;
    }
    if (line.type === 'remove') {
      // Removed lines have no newLine — use the hunk's new-file range as proxy
      return hunkNewEnd >= startLine && hunk.newStart <= endLine;
    }
    return false;
  });
}

/** Filter out annotations whose referenced lines have been modified or deleted. */
export function evictStaleAnnotations(
  annotations: ReviewAnnotation[],
  files: FileDiff[],
): ReviewAnnotation[] {
  const fileMap = new Map(files.map((f) => [f.path, f]));

  return annotations.filter((a) => {
    const file = fileMap.get(a.filePath);
    if (!file) return true;
    if (file.status === 'D') return false;
    return !file.hunks.some((h) => hunkTouchesRange(h, a.startLine, a.endLine));
  });
}
