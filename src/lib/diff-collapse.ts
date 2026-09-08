import type { FileDiff } from './unified-diff-parser';

/**
 * Changed lines (added + removed) above which a diff is treated as "large".
 * Every changed line becomes a DOM row with syntax highlighting, so this is
 * what makes a diff concentrated in a few files expensive.
 */
export const LARGE_DIFF_LINE_THRESHOLD = 2000;

/**
 * Modified-file count above which a diff is treated as "large" regardless of
 * its size. Each modified file renders a trailing context gap that fetches the
 * whole file over IPC on mount, so a wide-but-shallow diff (a rename sweep, a
 * lint autofix) is expensive even though it changes few lines.
 */
export const LARGE_DIFF_FILE_THRESHOLD = 30;

/** Count added + removed lines across all files. */
export function countChangedLines(files: readonly FileDiff[]): number {
  let total = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type !== 'context') total++;
      }
    }
  }
  return total;
}

export function isLargeDiff(files: readonly FileDiff[]): boolean {
  return (
    files.length > LARGE_DIFF_FILE_THRESHOLD || countChangedLines(files) > LARGE_DIFF_LINE_THRESHOLD
  );
}

/**
 * Initial collapsed-file set for a freshly loaded diff. Small diffs render
 * fully expanded (empty set); large ones collapse everything except the file
 * the user clicked to open the dialog — falling back to the first file when
 * that path isn't part of this diff, so the view is never entirely collapsed.
 */
export function getInitialCollapsedFiles(
  files: readonly FileDiff[],
  keepExpandedPath: string | null,
): ReadonlySet<string> {
  if (!isLargeDiff(files)) return new Set<string>();
  const requested = files.some((file) => file.path === keepExpandedPath);
  const keep = requested ? keepExpandedPath : files[0]?.path;
  const collapsed = new Set<string>();
  for (const file of files) {
    if (file.path !== keep) collapsed.add(file.path);
  }
  return collapsed;
}

/** Number of occurrences of `query` in one file's diff lines (case-insensitive). */
export function countFileSearchMatches(file: FileDiff, query: string | undefined): number {
  if (!query) return 0;
  const needle = query.toLowerCase();
  let count = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const haystack = line.content.toLowerCase();
      let idx = haystack.indexOf(needle);
      while (idx !== -1) {
        count++;
        idx = haystack.indexOf(needle, idx + needle.length);
      }
    }
  }
  return count;
}

/** Total occurrences of `query` across every file's diff lines. */
export function countSearchMatches(files: readonly FileDiff[], query: string | undefined): number {
  if (!query) return 0;
  return files.reduce((sum, file) => sum + countFileSearchMatches(file, query), 0);
}
