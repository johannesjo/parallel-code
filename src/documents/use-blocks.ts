import { createEffect, createSignal, onCleanup } from 'solid-js';
import { renderDocumentBlocks, type DocumentBlock } from './markdown-blocks';

/**
 * Reactively renders a markdown source into blocks. Stale renders are dropped
 * when the source changes again before they finish.
 */
export function createRenderedBlocks(source: () => string | null | undefined): {
  blocks: () => DocumentBlock[];
  rendering: () => boolean;
} {
  const [blocks, setBlocks] = createSignal<DocumentBlock[]>([]);
  const [rendering, setRendering] = createSignal(false);
  let generation = 0;

  createEffect(() => {
    const content = source();
    const gen = ++generation;
    if (content === null || content === undefined) {
      setBlocks([]);
      setRendering(false);
      return;
    }
    setRendering(true);
    renderDocumentBlocks(content)
      .then((result) => {
        if (gen === generation) setBlocks(result);
      })
      .catch((err) => console.warn('[documents] render failed:', err))
      .finally(() => {
        if (gen === generation) setRendering(false);
      });
  });

  onCleanup(() => {
    generation++;
  });

  return { blocks, rendering };
}

/** Renders mermaid placeholders inside a container after its HTML is set. */
export function renderMermaidIn(container: HTMLElement | undefined, key: string): void {
  if (!container) return;
  const nodes = container.querySelectorAll<HTMLElement>('.mermaid-block:not(.mermaid-rendered)');
  if (nodes.length === 0) return;
  import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, theme: 'dark' });
    nodes.forEach((el, i) => {
      const source = el.getAttribute('data-mermaid');
      if (!source) return;
      mermaid
        .render(`mermaid-doc-${key}-${Date.now()}-${i}`, source)
        .then(({ svg }) => {
          el.innerHTML = svg; // nosemgrep: semgrep.no-inner-html-without-sanitize -- mermaid renders its own sanitized SVG from document text
          el.classList.add('mermaid-rendered');
        })
        .catch(() => undefined);
    });
  });
}
