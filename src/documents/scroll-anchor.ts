import type { DocumentBlock } from './markdown-blocks';

/**
 * The passage a reader is on and where it sat in the viewport. A document
 * re-renders whole whenever its file changes — an agent editing the checkout,
 * a block saved from the source editor — which throws away every node the
 * browser could have anchored the scroll to, so the position is held by hand.
 */
export interface ScrollAnchor {
  index: number;
  /** The block's source text: the same passage is found again after an edit. */
  raw: string;
  /** The text just above it, which tells two identical passages apart. */
  before: string | null;
  /** Distance from the top of the scroller to the block's top, in px. */
  offset: number;
}

const BLOCK_SELECTOR = '[data-block-index]';

/**
 * Where the anchored passage now is: the same text when it is still in the
 * document, otherwise whatever took its index. An edit above the reading
 * position shifts every index below it, so the text is matched first — and a
 * match that brought its neighbour along beats a nearer one that did not,
 * since a document repeats a separator or a boilerplate line far more often
 * than it repeats a pair of them.
 *
 * `relocateAnchor` answers a similar question for notes, but fuzzily and
 * against a recorded commit. A scroll anchor is only ever compared with the
 * render it was taken from a moment earlier, where an exact match is both
 * cheaper and truer.
 */
export function anchorIndexIn(
  blocks: readonly DocumentBlock[],
  anchor: ScrollAnchor,
): number | null {
  if (blocks.length === 0) return null;
  const sameText = (i: number) => blocks[i]?.raw === anchor.raw;
  const sameNeighbour = (i: number) =>
    sameText(i) && (blocks[i - 1]?.raw ?? null) === anchor.before;
  if (sameNeighbour(anchor.index)) return anchor.index;
  let loose = sameText(anchor.index) ? anchor.index : null;
  // Both ends of the document are in reach: an edit can move a passage any
  // distance, and a document that lost most of itself moves it a long way.
  const reach = Math.max(anchor.index, blocks.length - 1 - anchor.index);
  for (let step = 1; step <= reach; step++) {
    // Downwards first: the edit this holds a position against is an insertion
    // above the reader, which pushes the passage down.
    for (const i of [anchor.index + step, anchor.index - step]) {
      if (sameNeighbour(i)) return i;
      if (loose === null && sameText(i)) loose = i;
    }
  }
  return loose ?? Math.min(anchor.index, blocks.length - 1);
}

/**
 * The topmost block still in view, the one a reader's eye is on. Null at the
 * top of the document, where staying at the top is what a reader expects.
 */
export function captureScrollAnchor(
  scroller: HTMLElement | undefined,
  blocks: readonly DocumentBlock[],
): ScrollAnchor | null {
  if (!scroller || scroller.scrollTop === 0 || blocks.length === 0) return null;
  const top = scroller.getBoundingClientRect().top;
  for (const el of scroller.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= top) continue;
    const index = Number(el.dataset.blockIndex);
    const block = blocks[index];
    if (!block) continue;
    return {
      index: block.index,
      raw: block.raw,
      before: blocks[index - 1]?.raw ?? null,
      offset: rect.top - top,
    };
  }
  return null;
}

/** Scrolls the anchored passage back under its old pixel; the new position. */
function restore(
  scroller: HTMLElement,
  anchor: ScrollAnchor,
  blocks: readonly DocumentBlock[],
): number {
  const index = anchorIndexIn(blocks, anchor);
  if (index === null) return scroller.scrollTop;
  const el = scroller.querySelector<HTMLElement>(`[data-block-index="${index}"]`);
  if (!el) return scroller.scrollTop;
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop += top - anchor.offset;
  return scroller.scrollTop;
}

/**
 * How long the anchor keeps its grip after a re-render. It is one window, not
 * a quiet period that restarts: what lays out late usually arrives once, and a
 * mermaid diagram — an async render behind a dynamically imported chunk — can
 * take most of a second to arrive at all. A window that waited only for the
 * next arrival would have expired before the one arrival came. It doubles as
 * the ceiling, so a page that animates its own layout cannot hold on for good.
 */
const HOLD_MS = 5000;

/**
 * How far the prose may drift before the reader is taken to have moved it.
 * A hedge, not a measurement: a scroll offset settles on whole device pixels,
 * which a zoomed window and a fractional restore do not land on. Kept because
 * the two failures are not the same size — a couple of pixels of a reader's
 * own scrolling overridden goes unnoticed, a hold dropped on a phantom nudge
 * puts the passage they were reading back off the screen.
 */
const READER_SLOP = 2;

/**
 * Puts the anchored passage back where it was, and holds it there while the
 * prose is still settling. The grip is let go the moment the reader scrolls —
 * their position beats ours — and once the document has had its time.
 * Returns a disposer for the caller's next re-render.
 */
export function holdScrollAnchor(
  scroller: HTMLElement | undefined,
  anchor: ScrollAnchor | null,
  blocks: readonly DocumentBlock[],
): () => void {
  if (!scroller || !anchor) return () => {};
  let held = restore(scroller, anchor, blocks);
  const deadline = Date.now() + HOLD_MS;
  const observer = new ResizeObserver(() => {
    // shortcut: any scroll the hold did not make reads as the reader, and a
    // document shrinking away under a scrollTop the browser then clamps is one
    // of those — measured at 1900px for a reader parked at the end. The hold
    // lets go there, never holds the wrong place. Watch for a real gesture if
    // anyone reports losing their place mid-restructure.
    if (Date.now() > deadline || Math.abs(scroller.scrollTop - held) > READER_SLOP) {
      observer.disconnect();
      return;
    }
    held = restore(scroller, anchor, blocks);
  });
  // The prose, not the scroller: a scroll container keeps its own size while
  // what is inside it grows.
  observer.observe(scroller.firstElementChild ?? scroller);
  return () => observer.disconnect();
}
