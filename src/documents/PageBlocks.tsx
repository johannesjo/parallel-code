import { For, createEffect, createSignal, on, onCleanup, type JSX } from 'solid-js';
import { createBlockActionsElement, type BlockActionKind } from './BlockActions';
import { Portal } from 'solid-js/web';
import type { BlockRange } from './DocumentViewer';
import type { BlockChange, DocumentBlock } from './markdown-blocks';

/** A whole HTML page ready to show: its body markup with blocks marked, and its CSS. */
export interface PageRender {
  stylesheet: string;
  html: string;
}

interface PageBlocksProps {
  html: string;
  blocks: DocumentBlock[];
  /** Scope root of the page's CSS; the viewer's stylesheet targets it. */
  pageKey: string;
  selectable?: boolean;
  selected: BlockRange | null;
  changes?: BlockChange[];
  scope?: BlockRange | null;
  blockMarker?: (index: number) => JSX.Element;
  /** Which blocks have a marker; only those get an anchor. */
  hasMarker?: (index: number) => boolean;
  onSelectSection: (index: number, e: MouseEvent) => void;
  onAction?: (action: BlockActionKind, index: number) => void;
}

/** Where a block's marker is rendered: a hook appended inside the block. */
interface MarkerAnchor {
  index: number;
  el: HTMLDivElement;
}

function inRange(range: BlockRange | null | undefined, index: number): boolean {
  return !!range && index >= range.start && index <= range.end;
}

/**
 * Renders a page's markup as one piece so its own layout and stylesheet hold,
 * and works on the blocks marked inside it by hand: marks are classes on the
 * page's elements, § buttons are appended to headings, and annotation markers
 * go into anchors appended inside their block. Every one of those is out of
 * the page's flow, so nothing the app adds moves the page's own elements.
 */
export function PageBlocks(props: PageBlocksProps) {
  const [body, setBody] = createSignal<HTMLDivElement>();
  const [anchors, setAnchors] = createSignal<MarkerAnchor[]>([]);

  const blockElement = (index: number) =>
    body()?.querySelector<HTMLElement>(`[data-block-index="${index}"]`) ?? null;

  // Every effect depends on `props.html` so it runs again once new markup is in place.
  createEffect(
    on([() => props.html, () => props.selected, () => props.changes, () => props.scope], () => {
      const root = body();
      if (!root) return;
      for (const el of root.querySelectorAll<HTMLElement>('[data-block-index]')) {
        const index = Number(el.dataset.blockIndex);
        const change = props.changes?.[index] ?? 'same';
        el.dataset.change = change;
        el.classList.toggle('is-selected', inRange(props.selected, index));
        el.classList.toggle('is-changed', change === 'changed');
        el.classList.toggle('is-added', change === 'added');
        el.classList.toggle('is-removed', change === 'removed');
        el.classList.toggle('is-scope', inRange(props.scope, index) && change === 'same');
      }
    }),
  );

  // Every block gets the hover toolbar, appended like the § button.
  createEffect(() => {
    const onAction = props.onAction;
    if (!props.html || !props.selectable || !onAction) return;
    for (const block of props.blocks) {
      const el = blockElement(block.index);
      if (!el || el.querySelector(':scope > .docws-block-actions')) continue;
      el.append(createBlockActionsElement((kind) => onAction(kind, block.index)));
    }
  });

  createEffect(() => {
    if (!props.html || !props.selectable) return;
    for (const block of props.blocks) {
      if (block.headingLevel === undefined) continue;
      const el = blockElement(block.index);
      if (!el || el.querySelector(':scope > .docws-section-btn')) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'docws-section-btn';
      button.title = 'Select this section';
      button.setAttribute('aria-label', `Select section ${block.headingText ?? ''}`);
      button.textContent = '§';
      button.onclick = (e) => props.onSelectSection(block.index, e);
      el.append(button);
    }
  });

  createEffect(() => {
    const wants = props.hasMarker;
    if (!props.html || !body() || !wants) {
      setAnchors([]);
      return;
    }
    const created: MarkerAnchor[] = [];
    for (const block of props.blocks) {
      if (!wants(block.index)) continue;
      const el = blockElement(block.index);
      if (!el) continue;
      const anchor = document.createElement('div');
      anchor.className = 'docws-marker-anchor';
      el.append(anchor);
      created.push({ index: block.index, el: anchor });
    }
    setAnchors(created);
    onCleanup(() => created.forEach((a) => a.el.remove()));
  });

  return (
    <>
      {/* eslint-disable-next-line solid/no-innerhtml -- page markup is DOMPurify-sanitized HTML from a local file */}
      <div class="docws-page-body" data-page={props.pageKey} ref={setBody} innerHTML={props.html} />
      <For each={anchors()}>
        {(anchor) => <Portal mount={anchor.el}>{props.blockMarker?.(anchor.index)}</Portal>}
      </For>
    </>
  );
}
