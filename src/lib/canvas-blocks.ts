/**
 * Turns an edit made in the WYSIWYG canvas into the smallest write that
 * brings the file on disk in line with it. The editor normalises Markdown
 * when it serialises (bullets, escapes, table padding), so writing the whole
 * document back would reformat lines the user never touched. Instead the
 * top-level blocks the editor started from are compared with the ones it
 * holds now, and only the changed run is written over its source range.
 */

/** Where a top-level block sits in the source, and what it is. */
export interface SourceBlock {
  /** 0-based offset of the block's first character. */
  start: number;
  /** Offset just past the block's last character (its trailing newline excluded). */
  end: number;
  /** Coarse block kind (`heading`, `list`, ...), used to check alignment. */
  kind: string;
}

/** A top-level block as the editor serialises it. */
export interface EditorBlock {
  text: string;
  kind: string;
}

export interface BlockWriteInput {
  source: string;
  /** Top-level blocks of `source`, in order. */
  sourceBlocks: SourceBlock[];
  /** The editor's blocks right after `source` was loaded. */
  baseBlocks: EditorBlock[];
  /** The editor's blocks now. */
  editedBlocks: EditorBlock[];
  /** The whole document as the editor serialises it now. */
  whole: string;
}

export interface BlockWrite {
  startOffset: number;
  endOffset: number;
  replacement: string;
}

function aligned(sourceBlocks: SourceBlock[], baseBlocks: EditorBlock[]): boolean {
  return (
    sourceBlocks.length === baseBlocks.length &&
    sourceBlocks.every((b, i) => b.kind === baseBlocks[i].kind)
  );
}

function commonPrefix(a: EditorBlock[], b: EditorBlock[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n].text === b[n].text) n++;
  return n;
}

function commonSuffix(a: EditorBlock[], b: EditorBlock[], prefix: number): number {
  let n = 0;
  while (
    n < a.length - prefix &&
    n < b.length - prefix &&
    a[a.length - 1 - n].text === b[b.length - 1 - n].text
  )
    n++;
  return n;
}

/**
 * The write that applies the editor's changes, or null when nothing changed.
 * Falls back to rewriting the whole file when the editor's blocks cannot be
 * matched to the source (raw HTML or link definitions shift the alignment).
 */
export function planBlockWrite(input: BlockWriteInput): BlockWrite | null {
  const { source, sourceBlocks, baseBlocks, editedBlocks, whole } = input;
  if (!aligned(sourceBlocks, baseBlocks)) {
    return { startOffset: 0, endOffset: source.length, replacement: whole };
  }
  const prefix = commonPrefix(baseBlocks, editedBlocks);
  const suffix = commonSuffix(baseBlocks, editedBlocks, prefix);
  if (prefix === baseBlocks.length && prefix === editedBlocks.length) return null;

  const lastChanged = baseBlocks.length - suffix; // exclusive
  const text = editedBlocks
    .slice(prefix, editedBlocks.length - suffix)
    .map((b) => b.text)
    .join('\n\n');

  if (prefix < lastChanged) {
    // shortcut: a deleted run also takes the gap before it, so no double blank line is left behind
    const swallowGap = text === '' && prefix > 0;
    return {
      startOffset: swallowGap ? sourceBlocks[prefix - 1].end : sourceBlocks[prefix].start,
      endOffset: sourceBlocks[lastChanged - 1].end,
      replacement: text,
    };
  }
  if (prefix > 0) {
    const at = sourceBlocks[prefix - 1].end;
    return { startOffset: at, endOffset: at, replacement: `\n\n${text}` };
  }
  if (sourceBlocks.length > 0) {
    const at = sourceBlocks[0].start;
    return { startOffset: at, endOffset: at, replacement: `${text}\n\n` };
  }
  return { startOffset: 0, endOffset: source.length, replacement: `${text}\n` };
}

/** The source as it reads once `write` has been applied to it. */
export function applyBlockWrite(source: string, write: BlockWrite): string {
  return source.slice(0, write.startOffset) + write.replacement + source.slice(write.endOffset);
}

const lineAt = (source: string, offset: number): number =>
  1 + (source.slice(0, offset).match(/\n/g)?.length ?? 0);

/** 1-based first and last source line of the blocks `from`..`to`, or null when
 *  the blocks are unknown (the editor has edits the source does not have yet). */
export function blockLineRange(
  source: string,
  sourceBlocks: SourceBlock[],
  from: number,
  to: number,
): { startLine: number; endLine: number } | null {
  const first = sourceBlocks[from];
  const last = sourceBlocks[to];
  if (!first || !last || from > to) return null;
  return { startLine: lineAt(source, first.start), endLine: lineAt(source, last.end) };
}
