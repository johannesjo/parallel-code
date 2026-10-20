/**
 * A rendered mermaid diagram at the size of the window. Plain DOM rather
 * than a component so every markdown surface (task notes, the plan dialog,
 * document workspaces) gets it from `renderMermaidIn` alone.
 */
import { isTopmost, popDialog, pushDialog } from './dialog-stack';

const LIGHTBOX_ID = 'mermaid-lightbox';

const CLOSE_GLYPH =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>';

const ENLARGE_GLYPH =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.75 10a.75.75 0 0 1 .75.75v2.69l3.22-3.22a.75.75 0 1 1 1.06 1.06L3.56 14.5h2.69a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75v-4.5a.75.75 0 0 1 .75-.75Zm12.5-4a.75.75 0 0 1-.75-.75V2.56l-3.22 3.22a.75.75 0 1 1-1.06-1.06L12.44 1.5H9.75a.75.75 0 0 1 0-1.5h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-.75.75Z"/></svg>';

/** Shows `svg` over the whole window until Esc, the close button or the backdrop. */
export function openMermaidLightbox(svg: SVGSVGElement, returnFocusTo?: HTMLElement): void {
  if (document.getElementById(LIGHTBOX_ID)) return;
  const overlay = document.createElement('div');
  overlay.id = LIGHTBOX_ID;
  overlay.className = 'mermaid-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Diagram');

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'mermaid-lightbox-close';
  close.setAttribute('aria-label', 'Close (Esc)');
  close.title = 'Close (Esc)';
  close.innerHTML = CLOSE_GLYPH; // nosemgrep: semgrep.no-inner-html-without-sanitize -- constant icon markup

  const body = document.createElement('div');
  body.className = 'mermaid-lightbox-body';
  // Mermaid pins its SVG to the width it was laid out at; the copy scales to
  // the box instead, keeping the diagram's own aspect through its viewBox.
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.removeAttribute('width');
  copy.removeAttribute('height');
  copy.style.maxWidth = 'none';
  copy.style.width = '100%';
  copy.style.height = '100%';
  body.append(copy);
  overlay.append(close, body);

  function dismiss() {
    overlay.remove();
    window.removeEventListener('keydown', onKey, true);
    popDialog(LIGHTBOX_ID);
    returnFocusTo?.focus();
  }
  // Capture phase, so the dialog underneath does not take the same Escape.
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !isTopmost(LIGHTBOX_ID)) return;
    e.stopPropagation();
    e.preventDefault();
    dismiss();
  }
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target === body) dismiss();
  });
  window.addEventListener('keydown', onKey, true);
  pushDialog(LIGHTBOX_ID);
  document.body.append(overlay);
  close.focus();
}

/** The corner button a rendered diagram gets: opens it in the lightbox. */
export function createEnlargeButton(block: HTMLElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mermaid-enlarge';
  button.setAttribute('aria-label', 'Enlarge diagram');
  button.title = 'Enlarge diagram';
  button.innerHTML = ENLARGE_GLYPH; // nosemgrep: semgrep.no-inner-html-without-sanitize -- constant icon markup
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const svg = block.querySelector('svg');
    if (svg) openMermaidLightbox(svg, button);
  });
  return button;
}
