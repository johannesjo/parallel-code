import { For, Index, Show, createEffect, createMemo, on, type JSX } from 'solid-js';
import { scopePageCss } from './html-blocks';
import type { BlockChange, DocumentBlock } from './markdown-blocks';
import { blockRangeText, nearestHeading, sectionRange } from './markdown-blocks';
import { PageBlocks, type PageRender } from './PageBlocks';
import type { DocumentSelection } from './store';
import { renderMermaidIn } from '../lib/mermaid';
import { findAnchorTarget, resolveDocumentLink } from './links';
import { BlockActions, type BlockActionKind } from './BlockActions';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { createHeldSignal } from '../lib/floating';

/** How long the hover toolbar waits for the pointer to reach it from the block. */
const TOOLBAR_HOLD_MS = 100;

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
  /** Review-only filter; indices stay tied to the complete document. */
  visibleBlock?: (index: number) => boolean;
  /** Blocks inside the run's scope (compare view context). */
  scope?: BlockRange | null;
  /**
   * Compare view: the changes this block leads, each shown as an include
   * toggle in its margin. Declining one keeps the base's version of that
   * passage. A block carries more than one only when two removals meet on it.
   */
  hunkLeads?: (index: number) => readonly { id: number; accepted: boolean; label: string }[];
  onToggleHunk?: (id: number) => void;
  /** True for blocks of a declined change: shown, but not what will land. */
  declined?: (index: number) => boolean;
  /** Unique key for mermaid ids. */
  renderKey: string;
  /** Rendered inside the block with this index: its annotation marker. */
  blockMarker?: (index: number) => JSX.Element;
  /** Which blocks have a marker; a page anchors one inside those alone. */
  hasMarker?: (index: number) => boolean;
  /**
   * A whole HTML page's markup and stylesheet. When set, the page renders as
   * itself on a light canvas, with the blocks marked inside it, instead of as
   * the app's markdown theme.
   */
  page?: PageRender | null;
  /** Repo-relative path of the rendered document; relative links resolve against it. */
  documentPath?: string;
  /** A link to another file of the project was clicked. */
  onNavigate?: (path: string, anchor?: string) => void;
  /** A block's hover toolbar was used: pick the block and open the composer on `action`. */
  onAction?: (action: BlockActionKind, index: number) => void;
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

/**
 * The document's own controls: a click on one is never a click on the prose.
 * An open note is one of them even though it floats over the window: reading
 * or editing it must not let go of the passage being worked on.
 */
const CONTROLS = 'a, button, input, textarea, .docws-marker, .docws-marker-pop, .docws-bubble';

/**
 * True for a mouse-up on the backdrop: the margins and the space below the
 * prose, where there is no block and no control. Clicking there lets the
 * picked passage go, the way clicking beside a dialog dismisses it. A drag
 * that merely ended out there keeps its range.
 */
export function releasesSelection(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el || el.closest(`[data-block-index], ${CONTROLS}`)) return false;
  const native = window.getSelection();
  return !native || native.isCollapsed;
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

  // The block under the pointer, held for a beat so the pointer can climb
  // onto the toolbar above it. Picked blocks have the composer up on them;
  // their toolbar would only repeat what it offers.
  const hovered = createHeldSignal<number>(TOOLBAR_HOLD_MS);
  const toolbarBlock = (): HTMLElement | null => {
    const index = hovered.value();
    const s = selected();
    if (index === null || (s && index >= s.start && index <= s.end)) return null;
    return containerRef?.querySelector<HTMLElement>(`[data-block-index="${index}"]`) ?? null;
  };
  function trackHover(e: MouseEvent) {
    // Solid delivers delegated events from the portalled toolbar and popover
    // here too; they are in the body, not the document, and not a block.
    if (!containerRef?.contains(e.target as Node)) return;
    const index = blockIndexOf(e.target as Node, containerRef);
    if (index === null) hovered.clear();
    else hovered.set(index);
  }

  const isPage = () => !!props.page;
  const pageKey = () => props.renderKey.replace(/["\\]/g, '');
  // Every viewer scopes the page's CSS to itself, so two versions of a page
  // side by side (base and candidate) cannot style each other.
  // The toggle gutter costs the prose 28px of indent, so it is opened only for
  // a column that is actually showing toggles — a base column, or a proposal
  // taken whole, keeps its full width.
  const hasHunkToggles = createMemo(() => {
    const leads = props.hunkLeads;
    if (!leads) return false;
    return props.blocks.some((_, i) => leads(i).length > 0);
  });

  const pageCss = createMemo(() =>
    props.page ? scopePageCss(props.page.stylesheet, `[data-page="${pageKey()}"]`) : '',
  );

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
    if (target?.closest(CONTROLS)) return;
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
    // Clicking the picked block again keeps it: a second click is how one
    // reaches for the passage already being worked on, not a way to drop it.
    // The backdrop, Esc and the composer's own × let it go.
    if (index !== null) emitRange({ start: index, end: index });
  }

  function selectSection(index: number, e: MouseEvent) {
    e.stopPropagation();
    const [start, end] = sectionRange(props.blocks, index);
    emitRange({ start, end });
  }

  // Links never navigate the app window: web links go to the browser, anchors
  // scroll, and other files of the project open in the workspace.
  function handleClick(e: MouseEvent) {
    const anchorEl = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href]');
    if (!anchorEl || !containerRef?.contains(anchorEl)) return;
    e.preventDefault();
    const link = resolveDocumentLink(anchorEl.getAttribute('href') ?? '', props.documentPath ?? '');
    if (!link) return;
    if (link.kind === 'external') {
      void invoke(IPC.ShellOpenExternal, { url: link.url });
    } else if (link.kind === 'anchor') {
      findAnchorTarget(containerRef, link.id)?.scrollIntoView({ block: 'start' });
    } else {
      props.onNavigate?.(link.path, link.anchor);
    }
  }

  return (
    <div
      ref={(el) => {
        containerRef = el;
      }}
      class="docws-content"
      classList={{
        'plan-markdown': !isPage(),
        'plan-markdown-dialog': !isPage(),
        'docws-page': isPage(),
        'docws-selectable': props.selectable === true,
        'docws-hunk-gutter': hasHunkToggles(),
      }}
      onMouseUp={handleMouseUp}
      onClick={handleClick}
      onMouseOver={trackHover}
      onMouseLeave={() => hovered.clear()}
    >
      <Show when={props.selectable && props.onAction}>
        <BlockActions
          anchor={toolbarBlock}
          alignLeft={isPage()}
          onAction={(kind) => {
            const index = hovered.value();
            if (index !== null) props.onAction?.(kind, index);
          }}
          onPointer={(inside) => (inside ? hovered.hold() : hovered.clear())}
        />
      </Show>
      <Show when={props.page}>
        {(page) => (
          <>
            <style>{pageCss()}</style>
            <PageBlocks
              html={page().html}
              blocks={props.blocks}
              pageKey={pageKey()}
              selectable={props.selectable}
              selected={selected()}
              changes={props.changes}
              scope={props.scope}
              blockMarker={props.blockMarker}
              hasMarker={props.hasMarker}
              onSelectSection={selectSection}
            />
          </>
        )}
      </Show>
      <For each={isPage() ? [] : props.blocks}>
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
            <>
              <div
                class="doc-block"
                data-block-index={i()}
                hidden={props.visibleBlock?.(i()) === false}
                data-change={change()}
                classList={{
                  'is-declined': props.declined?.(i()) === true,
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
                <Show when={props.hunkLeads?.(i())?.length}>
                  <span class="docws-hunk-toggles">
                    <Index each={props.hunkLeads?.(i())}>
                      {(hunk) => (
                        <label class="docws-hunk-toggle" title={hunk().label}>
                          <input
                            type="checkbox"
                            checked={hunk().accepted}
                            aria-label={hunk().label}
                            onChange={() => props.onToggleHunk?.(hunk().id)}
                          />
                        </label>
                      )}
                    </Index>
                  </span>
                </Show>
                {/* The marker sits in the block's margin, out of the prose:
                  it is not part of the passage, so clicking it must not toggle
                  the selection and the highlight stops at the text. */}
                {props.blockMarker?.(i())}
                {/* eslint-disable-next-line solid/no-innerhtml -- block HTML is DOMPurify-sanitized markdown from a local file */}
                <div innerHTML={block.html} />
              </div>
            </>
          );
        }}
      </For>
    </div>
  );
}
