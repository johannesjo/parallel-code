import { batch, createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import type { DocumentBlock } from './markdown-blocks';
import type { PageRender } from './PageBlocks';
import { renderDocument } from './render-document';
import { captureScrollAnchor, holdScrollAnchor } from './scroll-anchor';

/**
 * Reactively renders a document source into blocks. Stale renders are dropped
 * when the source changes again before they finish.
 *
 * `scroller` is the element the blocks scroll in, when they scroll in one: a
 * re-render replaces every block, so the reading position is held across it
 * and an edit elsewhere in the file does not move the passage being read.
 */
export function createRenderedBlocks(
  source: () => string | null | undefined,
  scroller?: () => HTMLElement | undefined,
): {
  blocks: () => DocumentBlock[];
  /** The page's markup and stylesheet when the source is a whole HTML page. */
  page: () => PageRender | null;
  rendering: () => boolean;
} {
  const [blocks, setBlocks] = createSignal<DocumentBlock[]>([]);
  const [page, setPage] = createSignal<PageRender | null>(null);
  const [rendering, setRendering] = createSignal(false);
  let generation = 0;
  /** Lets go of the reading position the last render was holding. */
  let release: (() => void) | undefined;

  createEffect(() => {
    const content = source();
    const gen = ++generation;
    if (content === null || content === undefined) {
      release?.();
      release = undefined;
      setBlocks([]);
      setPage(null);
      setRendering(false);
      return;
    }
    setRendering(true);
    renderDocument(content)
      .then((result) => {
        if (gen !== generation) return;
        // Measured before the swap, applied after it: Solid patches the DOM
        // synchronously as the signals are written. The blocks are read
        // untracked because this continuation is nobody's dependency.
        const anchor = captureScrollAnchor(scroller?.(), untrack(blocks));
        batch(() => {
          setBlocks(result.blocks);
          setPage(result.page);
        });
        release?.();
        release = holdScrollAnchor(scroller?.(), anchor, result.blocks);
      })
      .catch((err) => console.warn('[documents] render failed:', err))
      .finally(() => {
        if (gen === generation) setRendering(false);
      });
  });

  onCleanup(() => {
    generation++;
    release?.();
  });

  return { blocks, page, rendering };
}
