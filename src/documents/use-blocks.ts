import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { DocumentBlock } from './markdown-blocks';
import type { PageRender } from './PageBlocks';
import { renderDocument } from './render-document';

/**
 * Reactively renders a document source into blocks. Stale renders are dropped
 * when the source changes again before they finish.
 */
export function createRenderedBlocks(source: () => string | null | undefined): {
  blocks: () => DocumentBlock[];
  /** The page's markup and stylesheet when the source is a whole HTML page. */
  page: () => PageRender | null;
  rendering: () => boolean;
} {
  const [blocks, setBlocks] = createSignal<DocumentBlock[]>([]);
  const [page, setPage] = createSignal<PageRender | null>(null);
  const [rendering, setRendering] = createSignal(false);
  let generation = 0;

  createEffect(() => {
    const content = source();
    const gen = ++generation;
    if (content === null || content === undefined) {
      setBlocks([]);
      setPage(null);
      setRendering(false);
      return;
    }
    setRendering(true);
    renderDocument(content)
      .then((result) => {
        if (gen !== generation) return;
        setBlocks(result.blocks);
        setPage(result.page);
      })
      .catch((err) => console.warn('[documents] render failed:', err))
      .finally(() => {
        if (gen === generation) setRendering(false);
      });
  });

  onCleanup(() => {
    generation++;
  });

  return { blocks, page, rendering };
}
