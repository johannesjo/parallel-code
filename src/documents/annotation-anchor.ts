import type { DocumentAnchor } from './types';
import { blockRangeText, nearestHeading, type DocumentBlock } from './markdown-blocks';

/** Characters of neighbouring text kept on either side of an anchor. */
const CONTEXT_CHARS = 160;

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Anchors a block range in the current document version. */
export function createAnchor(
  blocks: readonly DocumentBlock[],
  startBlock: number,
  endBlock: number,
  path: string,
  baseSha: string | null,
): DocumentAnchor {
  const start = Math.max(0, Math.min(startBlock, endBlock));
  const end = Math.min(blocks.length - 1, Math.max(startBlock, endBlock));
  const before = blocks[start - 1]?.raw ?? '';
  const after = blocks[end + 1]?.raw ?? '';
  return {
    path,
    baseSha,
    startLine: blocks[start].startLine,
    endLine: blocks[end].endLine,
    quote: blockRangeText(blocks, start, end),
    prefix: normalize(before).slice(-CONTEXT_CHARS),
    suffix: normalize(after).slice(0, CONTEXT_CHARS),
    heading: nearestHeading(blocks, start),
  };
}

export interface AnchorLocation {
  startBlock: number;
  endBlock: number;
  /** True when the anchor was found at its recorded lines; false when relocated. */
  exact: boolean;
}

/** Word bigrams, or the words themselves when the text is too short for one. */
function grams(text: string): string[] {
  const words = text.split(' ').filter(Boolean);
  if (words.length < 2) return words;
  const out: string[] = [];
  for (let i = 0; i < words.length - 1; i++) out.push(`${words[i]} ${words[i + 1]}`);
  return out;
}

function gramCounts(grams: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const g of grams) counts.set(g, (counts.get(g) ?? 0) + 1);
  return counts;
}

/** The quoted passage, measured once for the whole search. */
interface Quote {
  counts: ReadonlyMap<string, number>;
  size: number;
  length: number;
}

function readQuote(text: string): Quote | null {
  const own = grams(text);
  if (own.length === 0) return null;
  return { counts: gramCounts(own), size: own.length, length: text.length };
}

/**
 * Sørensen–Dice over word bigrams: cheap, and stable under the rewording that
 * is this product's normal case rather than its edge case. An agent that
 * sharpens a sentence must not orphan the note attached to it.
 *
 * The quote's own gram counts are built once and reused across every candidate
 * run, because the search scores O(blocks x MAX_RUN) of them and rebuilding
 * the map each time dominated the cost on long documents.
 */
function similarity(quote: Quote, candidate: readonly string[]): number {
  if (quote.size === 0 || candidate.length === 0) return 0;
  const used = new Map<string, number>();
  let shared = 0;
  for (const g of candidate) {
    const already = used.get(g) ?? 0;
    if (already < (quote.counts.get(g) ?? 0)) {
      shared++;
      used.set(g, already + 1);
    }
  }
  return (2 * shared) / (quote.size + candidate.length);
}

/**
 * A neighbour shorter than this is a separator or a bare marker, which two
 * unrelated passages can carry by accident.
 */
const BOUNDARY_MIN = 6;

/** Below this the passage is a different passage, not a reworded one. */
const FUZZY_FLOOR = 0.5;
/** How far ahead of the next unrelated passage the winner must be. */
const FUZZY_MARGIN = 0.1;
/** Blocks a passage may have grown to; bounds the search on long documents. */
const MAX_RUN = 6;
/** Lines within which a passage is taken to be the one that was annotated. */
const NEAR_LINES = 20;

interface Scored extends AnchorLocation {
  score: number;
}

/** A candidate span of blocks, with its text run together. */
interface Run {
  start: number;
  end: number;
  text: string;
}

interface Search {
  anchor: DocumentAnchor;
  blocks: readonly DocumentBlock[];
  keys: readonly string[];
  quote: Quote;
}

/**
 * True when a run lies on the far side of one of the anchor's own boundaries.
 * An anchor records the block before its passage and the block after it, so
 * those two blocks bracket where the passage can be: a run reaching the
 * recorded suffix has passed the end, and one reaching back to the recorded
 * prefix has not yet arrived at the start. Each is scanned over the run plus
 * the block on the side the neighbour does *not* belong on, so finding the
 * suffix at the run's own start — or the prefix just after its end — is what
 * it is: the passage next door, worded like the one the note was written
 * against. Without this a deleted passage hands its note to a surviving
 * sibling, which is the worst thing anchoring can do.
 */
function crossesBoundary(anchor: DocumentAnchor, keys: readonly string[], run: Run): boolean {
  const { prefix, suffix } = anchor;
  if (suffix && suffix.length >= BOUNDARY_MIN) {
    for (let i = Math.max(run.start - 1, 0); i <= run.end; i++) {
      if (keys[i].startsWith(suffix)) return true;
    }
  }
  if (!prefix || prefix.length < BOUNDARY_MIN) return false;
  for (let i = run.start; i <= Math.min(run.end + 1, keys.length - 1); i++) {
    if (keys[i].endsWith(prefix)) return true;
  }
  return false;
}

/** A run's score, or null when it is no plausible home for the anchor. */
function scoreRun(search: Search, run: Run): number | null {
  const { anchor, blocks, keys } = search;
  if (crossesBoundary(anchor, keys, run)) return null;
  const base = similarity(search.quote, grams(run.text));
  if (base < FUZZY_FLOOR) return null;
  let score = base;
  if (anchor.prefix && (keys[run.start - 1] ?? '').endsWith(anchor.prefix)) score += 0.05;
  if (anchor.suffix && (keys[run.end + 1] ?? '').startsWith(anchor.suffix)) score += 0.05;
  if (anchor.heading && nearestHeading(blocks, run.start) === anchor.heading) score += 0.03;
  if (Math.abs(blocks[run.start].startLine - anchor.startLine) <= NEAR_LINES) score += 0.02;
  return score;
}

/** The best run beginning at a block, grown until it outgrows the quote. */
function bestRunFrom(search: Search, start: number): Scored | null {
  const { anchor, blocks, keys } = search;
  let text = '';
  let top: Scored | null = null;
  for (let end = start; end < blocks.length && end - start < MAX_RUN; end++) {
    const key = keys[end];
    if (key) text = text ? `${text} ${key}` : key;
    if (!text) continue;
    // A run twice the quote's length is no longer the same passage.
    if (text.length > search.quote.length * 2 && end > start) break;
    const score = scoreRun(search, { start, end, text });
    if (score === null || (top && score <= top.score)) continue;
    const exact =
      blocks[start].startLine === anchor.startLine && blocks[end].endLine === anchor.endLine;
    top = { startBlock: start, endBlock: end, exact, score };
  }
  return top;
}

/**
 * The best relocation by text similarity when nothing matches verbatim.
 * Neighbours, heading and the recorded lines break ties, the way they do for
 * an exact match; anything below the floor, or too close to an unrelated
 * passage, stays detached.
 */
function relocateFuzzy(
  anchor: DocumentAnchor,
  blocks: readonly DocumentBlock[],
  keys: readonly string[],
): AnchorLocation | null {
  const quote = readQuote(normalize(anchor.quote));
  if (!quote) return null;
  const search: Search = { anchor, blocks, keys, quote };

  const best: Scored[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const top = bestRunFrom(search, i);
    if (top) best.push(top);
  }
  if (best.length === 0) return null;
  best.sort((a, b) => b.score - a.score);
  const winner = best[0];
  // Runs that overlap the winner are the same passage measured differently;
  // only a separate passage scoring nearly as well makes this ambiguous.
  const rival = best.find((c) => c.startBlock > winner.endBlock || c.endBlock < winner.startBlock);
  if (rival && winner.score - rival.score < FUZZY_MARGIN) return null;
  return { startBlock: winner.startBlock, endBlock: winner.endBlock, exact: winner.exact };
}

/**
 * Finds an anchor in the current blocks. Matches the quoted blocks by text,
 * then — because agents reword the passages people annotate — by similarity;
 * when the same passage appears more than once, the surrounding text and the
 * heading decide. Returns null rather than guessing: a detached bubble is
 * honest, a misplaced one is not.
 */
export function relocateAnchor(
  anchor: DocumentAnchor,
  blocks: readonly DocumentBlock[],
): AnchorLocation | null {
  if (blocks.length === 0) return null;
  // The quote is the blocks' own text run together, and a single block can
  // hold a blank line of its own (a loose list, a fenced snippet, an HTML
  // element). Splitting the quote on blank lines would therefore count more
  // pieces than there are blocks and match nothing, so grow a run of blocks
  // until it reproduces the quote instead.
  const wanted = normalize(anchor.quote);
  if (!wanted) return null;
  const keys = blocks.map((b) => normalize(b.raw));

  const candidates: AnchorLocation[] = [];
  for (let i = 0; i < blocks.length; i++) {
    let text = '';
    for (let end = i; end < blocks.length; end++) {
      const key = keys[end];
      if (key) text = text ? `${text} ${key}` : key;
      if (text.length > wanted.length) break;
      if (text !== wanted) continue;
      const exact =
        blocks[i].startLine === anchor.startLine && blocks[end].endLine === anchor.endLine;
      candidates.push({ startBlock: i, endBlock: end, exact });
      break;
    }
  }
  if (candidates.length === 0) return relocateFuzzy(anchor, blocks, keys);
  if (candidates.length === 1) return candidates[0];

  const score = (c: AnchorLocation): number => {
    let s = 0;
    if (c.exact) s += 4;
    const before = keys[c.startBlock - 1] ?? '';
    const after = keys[c.endBlock + 1] ?? '';
    if (anchor.prefix && before.endsWith(anchor.prefix)) s += 2;
    if (anchor.suffix && after.startsWith(anchor.suffix)) s += 2;
    if (anchor.heading && nearestHeading(blocks, c.startBlock) === anchor.heading) s += 1;
    return s;
  };
  const ranked = candidates.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s);
  // Two equally good matches: refuse to pick one.
  if (ranked[0].s === ranked[1].s) return null;
  return ranked[0].c;
}
