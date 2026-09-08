/**
 * Renders the `.mermaid-block` placeholders that the markdown renderers emit
 * for ```mermaid fences into SVG diagrams.
 *
 * @param container element holding the freshly inserted markdown HTML
 * @param key unique per rendering surface, so ids stay distinct when the same
 *   document is on screen twice (inline plan tab and plan dialog, for example)
 */
import { createEnlargeButton } from './mermaid-lightbox';

export function renderMermaidIn(container: HTMLElement | undefined, key: string): void {
  if (!container) return;
  const nodes = container.querySelectorAll<HTMLElement>('.mermaid-block:not(.mermaid-rendered)');
  if (nodes.length === 0) return;
  import('mermaid')
    .then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: 'dark' });
      nodes.forEach((el, i) => {
        // The sanitizer strips any attribute whose value contains `-->`, which
        // is most flowchart arrows, so `data-mermaid` is gone for exactly the
        // diagrams people write most. The placeholder's own text is the same
        // source and survives sanitizing, so fall back to it.
        const source = el.getAttribute('data-mermaid') || el.textContent || '';
        if (!source.trim()) return;
        mermaid
          .render(`mermaid-${key}-${Date.now()}-${i}`, source)
          .then(({ svg }) => {
            el.innerHTML = svg; // nosemgrep: semgrep.no-inner-html-without-sanitize -- mermaid renders its own sanitized SVG from local markdown
            el.classList.add('mermaid-rendered');
            // Diagrams outgrow a prose column; the corner button shows them at
            // the size of the window.
            el.append(createEnlargeButton(el));
          })
          .catch((err) => console.warn('[mermaid] render failed:', err));
      });
    })
    .catch((err) => console.warn('[mermaid] load failed:', err));
}
