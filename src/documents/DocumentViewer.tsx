import { For, Show, createEffect, createMemo, on, type JSX } from 'solid-js';
import type { BlockChange, DocumentBlock } from '../lib/markdown-blocks';
import { blockRangeText, nearestHeading, sectionRange } from '../lib/markdown-blocks';
import type { DocumentSelection } from '../store/documents';
import { renderMermaidIn } from './use-blocks';

export interface BlockRange {
  start: number;
  end: number;
}

interface DocumentViewerProps {
  blocks: DocumentBlock[];
  /** Renders selection affordances and reports selections. */
  selectable?: boolean;
  selection?: BlockRange | null;
  onSelect?: (selection: DocumentSelection | null) => void;
  /** Per-block change marks for the compare view. */
  changes?: BlockChange[];
  /** Blocks inside the run's scope (compare view context). */
  scope?: BlockRange | null;
  /** Unique key for mermaid ids. */
  renderKey: string;
  onContainer?: (el: HTMLDivElement) => void;
  children?: JSX.Element;
}

export function selectionFromRange(
  blocks: readonly DocumentBlock[],
  range: BlockRange,
): DocumentSelection {
  const start = Math.max(0, Math.min(range.start, range.end));
  const end = Math.min(blocks.length - 1, Math.max(range.start, range.end));
  return {
    startBlock: start,
    endBlock: end,
    startLine: blocks[start].startLine,
    endLine: blocks[end].endLine,
    quote: blockRangeText(blocks, start, end),
    heading: nearestHeading(blocks, start),
    wholeDocument: false,
  };
}

function blockIndexOf(node: Node | null, container: HTMLElement): number | null {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el && el !== container) {
    const raw = el.dataset.blockIndex;
    if (raw !== undefined) return Number(raw);
    el = el.parentElement;
  }
  return null;
}

export function DocumentViewer(props: DocumentViewerProps) {
  let containerRef: HTMLDivElement | undefined;

  const selected = createMemo(() => {
    const s = props.selection;
    if (!s) return null;
    return { start: Math.min(s.start, s.end), end: Math.max(s.start, s.end) };
  });

  createEffect(
    on(
      () => props.blocks,
      () => {
        const key = props.renderKey;
        queueMicrotask(() => renderMermaidIn(containerRef, key));
      },
    ),
  );

  function emitRange(range: BlockRange | null) {
    if (!props.onSelect) return;
    if (!range || props.blocks.length === 0) {
      props.onSelect(null);
      return;
    }
    props.onSelect(selectionFromRange(props.blocks, range));
  }

  function handleMouseUp(e: MouseEvent) {
    if (!props.selectable || !containerRef) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('a, button, input, textarea, .docws-composer')) return;
    const native = window.getSelection();
    if (native && !native.isCollapsed && native.rangeCount > 0) {
      const range = native.getRangeAt(0);
      const start = blockIndexOf(range.startContainer, containerRef);
      const end = blockIndexOf(range.endContainer, containerRef);
      if (start === null && end === null) return;
      // A drag across several blocks scopes them; a selection inside one block
      // stays a plain text selection so copying keeps working. Click the block
      // to scope it. The native range is left alone for the same reason.
      const from = start ?? end ?? 0;
      const to = end ?? start ?? 0;
      if (from !== to) emitRange({ start: from, end: to });
      return;
    }
    const index = blockIndexOf(target, containerRef);
    if (index === null) return;
    const current = selected();
    if (current && current.start === index && current.end === index) emitRange(null);
    else emitRange({ start: index, end: index });
  }

  function selectSection(index: number, e: MouseEvent) {
    e.stopPropagation();
    const [start, end] = sectionRange(props.blocks, index);
    emitRange({ start, end });
  }

  return (
    <div
      ref={(el) => {
        containerRef = el;
        props.onContainer?.(el);
      }}
      class="plan-markdown plan-markdown-dialog docws-content"
      classList={{ 'docws-selectable': props.selectable === true }}
      onMouseUp={handleMouseUp}
    >
      <For each={props.blocks}>
        {(block, i) => {
          const change = () => props.changes?.[i()] ?? 'same';
          const isSelected = () => {
            const s = selected();
            return !!s && i() >= s.start && i() <= s.end;
          };
          const inScope = () => {
            const s = props.scope;
            return !!s && i() >= s.start && i() <= s.end;
          };
          return (
            <div
              class="doc-block"
              data-block-index={i()}
              data-change={change()}
              classList={{
                'is-selected': isSelected(),
                'is-changed': change() === 'changed',
                'is-added': change() === 'added',
                'is-removed': change() === 'removed',
                'is-scope': inScope() && change() === 'same',
              }}
            >
              <Show when={props.selectable && block.headingLevel !== undefined}>
                <button
                  type="button"
                  class="docws-section-btn"
                  title="Select this section"
                  aria-label={`Select section ${block.headingText ?? ''}`}
                  onClick={(e) => selectSection(i(), e)}
                >
                  §
                </button>
              </Show>
              {/* eslint-disable-next-line solid/no-innerhtml -- block HTML is DOMPurify-sanitized markdown from a local file */}
              <div innerHTML={block.html} />
            </div>
          );
        }}
      </For>
      {props.children}
    </div>
  );
}
