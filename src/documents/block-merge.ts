import {
  normalizeSource,
  renderDocumentBlocks,
  type BlockChange,
  type DocumentBlock,
} from './markdown-blocks';

/**
 * One reviewable change: a run of base blocks a candidate replaced by a run of
 * its own. Either run may be empty — an empty base run is an insertion, an
 * empty candidate run a deletion. Hunks are the unit of partial acceptance,
 * because a paragraph is the smallest thing a reader decides about.
 */
export interface BlockHunk {
  id: number;
  /** Half-open ranges of block indices. */
  baseStart: number;
  baseEnd: number;
  candStart: number;
  candEnd: number;
}

/** The text a block is compared by, matching `diffBlocks`. */
function key(block: DocumentBlock): string {
  return block.raw.replace(/\s+/g, ' ').trim();
}

/**
 * Groups a block diff into hunks. `diffBlocks` marks matched blocks `same` in
 * both arrays and in the same order, so walking the two together pairs the
 * unmatched runs between matches.
 */
export function blockHunks(diff: { base: BlockChange[]; candidate: BlockChange[] }): BlockHunk[] {
  const hunks: BlockHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < diff.base.length || j < diff.candidate.length) {
    if (diff.base[i] === 'same' && diff.candidate[j] === 'same') {
      i++;
      j++;
      continue;
    }
    const baseStart = i;
    const candStart = j;
    while (i < diff.base.length && diff.base[i] !== 'same') i++;
    while (j < diff.candidate.length && diff.candidate[j] !== 'same') j++;
    if (i === baseStart && j === candStart) {
      // Neither side advanced: the arrays disagree about their matches, which
      // diffBlocks cannot produce. Step over it rather than spin forever.
      i++;
      j++;
      continue;
    }
    hunks.push({ id: hunks.length, baseStart, baseEnd: i, candStart, candEnd: j });
  }
  return hunks;
}

export type HunkKind = 'rewrite' | 'insertion' | 'deletion';

export function hunkKind(hunk: BlockHunk): HunkKind {
  if (hunk.baseStart === hunk.baseEnd) return 'insertion';
  if (hunk.candStart === hunk.candEnd) return 'deletion';
  return 'rewrite';
}

/** Enough of a passage to recognise it, on one line. */
function snippet(text: string): string {
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

/** "line 4" or "lines 4–9". */
function lineSpan(from: number, to: number): string {
  return from === to ? `line ${from}` : `lines ${from}–${to}`;
}

/**
 * What a toggle does, for its tooltip and screen readers. Each names where it
 * lands in the base: several toggles share a screen and would otherwise read
 * alike. A deletion quotes the passage it drops instead, since its checkbox
 * sits on a block that follows it and nothing on screen ties the two together.
 */
export function hunkLabel(hunk: BlockHunk, baseBlocks?: readonly DocumentBlock[]): string {
  const kind = hunkKind(hunk);
  const first = baseBlocks?.[hunk.baseStart];
  if (kind === 'insertion') {
    if (first) return `Include this new passage before line ${first.startLine}`;
    return baseBlocks?.length ? 'Include this new passage at the end' : 'Include this new passage';
  }
  if (kind === 'rewrite') {
    const last = baseBlocks?.[hunk.baseEnd - 1];
    return first && last
      ? `Include this rewrite of ${lineSpan(first.startLine, last.endLine)}`
      : 'Include this rewrite';
  }
  const removed = first ? key(first) : '';
  return removed ? `Include this removal: “${snippet(removed)}”` : 'Include this removal';
}

/**
 * The block that carries a hunk's toggle in the candidate column. A rewrite or
 * an insertion owns its own blocks; a deletion has none, so it hangs on the
 * block that follows it — the base column is where the dropped passage is
 * shown. Returns null only when the candidate has no blocks at all.
 */
export function hunkLeadBlock(hunk: BlockHunk, candidateBlockCount: number): number | null {
  if (hunk.candStart < hunk.candEnd) return hunk.candStart;
  if (hunk.candStart < candidateBlockCount) return hunk.candStart;
  return candidateBlockCount > 0 ? candidateBlockCount - 1 : null;
}

/**
 * Maps each block to the hunks whose toggles sit on it. Two deletions can land
 * on one block — the last block of the document takes every deletion that ends
 * it — so a block carries a list rather than a single hunk; dropping the
 * second would leave a change the reader cannot decline.
 */
export function hunkLeadBlocks(
  hunks: readonly BlockHunk[],
  candidateBlockCount: number,
): Map<number, BlockHunk[]> | null {
  const leads = new Map<number, BlockHunk[]>();
  for (const hunk of hunks) {
    const index = hunkLeadBlock(hunk, candidateBlockCount);
    if (index === null) return null;
    const at = leads.get(index);
    if (at) at.push(hunk);
    else leads.set(index, [hunk]);
  }
  return leads;
}

/** A block's exact span in the normalized source, verified against its text. */
function spanOf(source: string, block: DocumentBlock | undefined): [number, number] | null {
  if (!block || block.startOffset === undefined || block.endOffset === undefined) return null;
  if (source.slice(block.startOffset, block.endOffset) !== block.raw.replace(/\n+$/, ''))
    return null;
  return [block.startOffset, block.endOffset];
}

/** The candidate text a hunk contributes; empty for a deletion. */
function candidateText(
  source: string,
  blocks: readonly DocumentBlock[],
  hunk: BlockHunk,
): string | null {
  if (hunk.candStart === hunk.candEnd) return '';
  const first = spanOf(source, blocks[hunk.candStart]);
  const last = spanOf(source, blocks[hunk.candEnd - 1]);
  if (!first || !last) return null;
  return source.slice(first[0], last[1]);
}

/**
 * The base span a hunk replaces. A deletion also swallows one separator, so
 * dropping a paragraph does not leave a hole of blank lines behind.
 */
function baseSpan(
  source: string,
  blocks: readonly DocumentBlock[],
  hunk: BlockHunk,
): [number, number] | null {
  if (hunk.baseStart === hunk.baseEnd) {
    // Insertion: a zero-width span before the block it precedes.
    const at = spanOf(source, blocks[hunk.baseStart]);
    if (at) return [at[0], at[0]];
    // Only an insertion past the last block may fall back to the end. A block
    // that failed verification must refuse, not silently append elsewhere.
    if (hunk.baseStart < blocks.length) return null;
    const last = spanOf(source, blocks[blocks.length - 1]);
    return last ? [last[1], last[1]] : null;
  }
  const first = spanOf(source, blocks[hunk.baseStart]);
  const last = spanOf(source, blocks[hunk.baseEnd - 1]);
  if (!first || !last) return null;
  if (hunk.candStart !== hunk.candEnd) return [first[0], last[1]];
  const after = spanOf(source, blocks[hunk.baseEnd]);
  if (after) return [first[0], after[0]];
  const before = spanOf(source, blocks[hunk.baseStart - 1]);
  return before ? [before[1], last[1]] : [first[0], last[1]];
}

/**
 * Markdown separates blocks by a blank line, but not always by two newlines: a
 * heading and its paragraph, or a paragraph and the list under it, sit on
 * consecutive lines. Splicing a different kind of block into such a seam would
 * fuse it with its neighbour — a list swallowing the paragraph after it — so
 * each seam of a spliced passage is opened to a blank line.
 */
function endBlank(accumulated: string): string {
  if (accumulated.trim() === '') return accumulated;
  return `${accumulated.replace(/\n*$/, '')}\n\n`;
}

function startBlank(rest: string): string {
  if (rest.trim() === '') return rest;
  return `\n\n${rest.replace(/^\n*/, '')}`;
}

export interface ComposeArgs {
  baseSource: string;
  baseBlocks: readonly DocumentBlock[];
  candidateSource: string;
  candidateBlocks: readonly DocumentBlock[];
  hunks: readonly BlockHunk[];
  /** Hunk ids the reader kept; the rest fall back to the base text. */
  accepted: ReadonlySet<number>;
}

/** The blocks the reader chose, in order: the yardstick the result must meet. */
export function expectedBlockKeys(args: ComposeArgs): string[] {
  const out: string[] = [];
  let i = 0;
  for (const hunk of args.hunks) {
    for (; i < hunk.baseStart; i++) out.push(key(args.baseBlocks[i]));
    if (args.accepted.has(hunk.id)) {
      for (let c = hunk.candStart; c < hunk.candEnd; c++) out.push(key(args.candidateBlocks[c]));
    } else {
      for (let b = hunk.baseStart; b < hunk.baseEnd; b++) out.push(key(args.baseBlocks[b]));
    }
    i = hunk.baseEnd;
  }
  for (; i < args.baseBlocks.length; i++) out.push(key(args.baseBlocks[i]));
  return out;
}

/**
 * Builds the document the reader chose: the base with every accepted hunk
 * replaced by the candidate's version of it. Returns null when a block's
 * recorded offsets no longer describe its text, so the caller can fall back to
 * accepting the candidate whole rather than write something it cannot verify.
 */
export function composeAcceptedDocument(args: ComposeArgs): string | null {
  const base = normalizeSource(args.baseSource);
  const candidate = normalizeSource(args.candidateSource);
  let merged = '';
  let cursor = 0;
  let openSeam = false;
  for (const hunk of args.hunks) {
    if (!args.accepted.has(hunk.id)) continue;
    const span = baseSpan(base, args.baseBlocks, hunk);
    const text = candidateText(candidate, args.candidateBlocks, hunk);
    if (!span || text === null) return null;
    // Hunks are disjoint and ordered; anything else means the diff and the
    // offsets disagree, and guessing would corrupt the document.
    if (span[0] < cursor) return null;
    const lead = base.slice(cursor, span[0]);
    merged += openSeam ? startBlank(lead) : lead;
    // A deletion opens no seam: it already swallowed the separator it left.
    openSeam = text !== '';
    if (text !== '') merged = `${endBlank(merged)}${text}`;
    cursor = span[1];
  }
  const tail = base.slice(cursor);
  merged += openSeam ? startBlank(tail) : tail;
  return args.baseSource.includes('\r\n') ? merged.replace(/\n/g, '\r\n') : merged;
}

/**
 * The composed document, but only if it re-reads as the blocks the reader
 * picked. Splicing text is not the same as splicing structure — markdown can
 * fuse two blocks that were separate in both sources — so the result is parsed
 * back and compared before anyone is allowed to commit it.
 */
export async function composeVerifiedDocument(args: ComposeArgs): Promise<string | null> {
  const merged = composeAcceptedDocument(args);
  if (merged === null) return null;
  const got = (await renderDocumentBlocks(merged)).map(key);
  const want = expectedBlockKeys(args);
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) return null;
  return merged;
}
