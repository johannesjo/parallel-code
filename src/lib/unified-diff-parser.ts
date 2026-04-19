/** Structured representation of a single diff line. */
export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

/** A contiguous hunk within a file diff. */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

/** Parsed diff for a single file. */
export interface FileDiff {
  path: string;
  status: 'M' | 'A' | 'D';
  binary: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse raw `git diff` output into structured FileDiff objects.
 *
 * Handles multiple files, add/modify/delete status, binary files,
 * multiple hunks, and the "no newline at end of file" marker.
 */
export function parseUnifiedDiff(raw: string): FileDiff[] {
  if (!raw.trim()) return [];

  // Split on `diff --git` boundaries, keeping each file block together.
  const blocks = raw.split(/^(?=diff --git )/m).filter((b) => b.trim());
  const files: FileDiff[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const fileDiff = parseFileBlock(lines);
    if (fileDiff) files.push(fileDiff);
  }

  return files;
}

/** Extract file path from the `diff --git a/<path> b/<path>` header. */
function extractPath(headerLine: string): string {
  // "diff --git a/foo/bar b/foo/bar" -> "foo/bar"
  const match = headerLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
  return match ? match[2] : '';
}

/** Parse a single file's diff block into a FileDiff. */
function parseFileBlock(lines: string[]): FileDiff | null {
  if (lines.length === 0) return null;

  const path = extractPath(lines[0]);
  if (!path) return null;

  let status: 'M' | 'A' | 'D' = 'M';
  let binary = false;

  // Scan metadata lines (everything before the first hunk header).
  for (const line of lines) {
    if (HUNK_HEADER_RE.test(line)) break;
    if (line.startsWith('new file mode')) status = 'A';
    if (line.startsWith('deleted file mode')) status = 'D';
    if (line.includes('Binary files') && line.includes('differ')) binary = true;
  }

  if (binary) {
    return { path, status, binary, hunks: [] };
  }

  const hunks = parseHunks(lines);
  return { path, status, binary, hunks };
}

/** Parse all hunks from a file block's lines. */
function parseHunks(lines: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
        lines: [],
      };
      hunks.push(currentHunk);
      oldLine = currentHunk.oldStart;
      newLine = currentHunk.newStart;
      continue;
    }

    if (!currentHunk) continue;

    // Skip "no newline at end of file" marker.
    if (line.startsWith('\\ ')) continue;

    const prefix = line[0];
    if (prefix === '+') {
      currentHunk.lines.push({
        type: 'add',
        content: line.slice(1),
        oldLine: null,
        newLine: newLine++,
      });
    } else if (prefix === '-') {
      currentHunk.lines.push({
        type: 'remove',
        content: line.slice(1),
        oldLine: oldLine++,
        newLine: null,
      });
    } else if (prefix === ' ') {
      currentHunk.lines.push({
        type: 'context',
        content: line.slice(1),
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }

  return hunks;
}
