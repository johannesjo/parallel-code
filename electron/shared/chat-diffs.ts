import type { ChatDiff } from './agent-chat-types.js';

/** A diff this long is summarised rather than carried in every state frame. */
const MAX_DIFF_LINES = 400;

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Counts the whole change, then caps what is carried: the totals stay true
 *  for a diff too long to show in full. */
function toDiff(path: string, lines: string[]): ChatDiff {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  const hidden = lines.length - MAX_DIFF_LINES;
  const shown = hidden > 0 ? [...lines.slice(0, MAX_DIFF_LINES), `… ${hidden} more lines`] : lines;
  return { path, diff: shown.join('\n'), added, removed };
}

const splitLines = (text: string) => (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');

/** Every line of `text` as added (`+`) or removed (`-`), for created or deleted files. */
export function wholeFileDiff(path: string, text: string, sign: '+' | '-'): ChatDiff {
  const lines = text ? splitLines(text) : [];
  const header = sign === '+' ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`;
  return toDiff(path, [header, ...lines.map((line) => sign + line)]);
}

/** Replacements without their surrounding file, as an agent proposes edits.
 *  A `⋯` line parts edits that may sit far apart in the file. */
export function replacementDiff(
  path: string,
  edits: { before: string; after: string }[],
): ChatDiff {
  const lines = edits.flatMap(({ before, after }, i) => [
    ...(i ? ['⋯'] : []),
    ...(before ? splitLines(before).map((line) => `-${line}`) : []),
    ...(after ? splitLines(after).map((line) => `+${line}`) : []),
  ]);
  return toDiff(path, lines);
}

function isHunk(value: unknown): value is Hunk {
  const hunk = value as Partial<Hunk> | null;
  return (
    !!hunk &&
    typeof hunk === 'object' &&
    [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(
      (n) => typeof n === 'number',
    ) &&
    Array.isArray(hunk.lines) &&
    hunk.lines.every((line) => typeof line === 'string')
  );
}

/** Claude's structured patch, or undefined when `value` is not one. */
export function hunksDiff(path: string, value: unknown): ChatDiff | undefined {
  if (!Array.isArray(value) || !value.length || !value.every(isHunk)) return undefined;
  return toDiff(
    path,
    value.flatMap((hunk) => [
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines,
    ]),
  );
}

/** A unified diff with any file headers dropped: the path is shown on its own. */
export function unifiedDiff(path: string, text: string): ChatDiff {
  const lines = splitLines(text);
  const start = lines.findIndex((line) => line.startsWith('@@'));
  return toDiff(path, start < 0 ? lines : lines.slice(start));
}
