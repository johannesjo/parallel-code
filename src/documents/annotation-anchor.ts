import type { DocumentAnchor } from '../ipc/types';
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

/**
 * Finds an anchor in the current blocks. Matches the quoted blocks by text;
 * when the same passage appears more than once, the surrounding text and the
 * heading decide. Returns null rather than guessing: a detached bubble is
 * honest, a misplaced one is not.
 */
export function relocateAnchor(
  anchor: DocumentAnchor,
  blocks: readonly DocumentBlock[],
): AnchorLocation | null {
  if (blocks.length === 0) return null;
  const wanted = anchor.quote
    .split(/\n\s*\n/)
    .map(normalize)
    .filter((t) => t.length > 0);
  if (wanted.length === 0) return null;
  const keys = blocks.map((b) => normalize(b.raw));

  const candidates: AnchorLocation[] = [];
  for (let i = 0; i + wanted.length <= blocks.length; i++) {
    let ok = true;
    for (let k = 0; k < wanted.length; k++) {
      if (keys[i + k] !== wanted[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const end = i + wanted.length - 1;
    const exact =
      blocks[i].startLine === anchor.startLine && blocks[end].endLine === anchor.endLine;
    candidates.push({ startBlock: i, endBlock: end, exact });
  }
  if (candidates.length === 0) return null;
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
