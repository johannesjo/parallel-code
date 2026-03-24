import { For, Show, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { getStatusColor } from '../lib/status-colors';
import { openFileInEditor } from '../lib/shell';
import { highlightLines, detectLang } from '../lib/shiki-highlighter';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { FileDiff, Hunk, DiffLine } from '../lib/unified-diff-parser';
import type { FileDiffResult } from '../ipc/types';
import { getDiffSelection, type DiffSelection } from '../lib/diff-selection';
import { AskCodeCard } from './AskCodeCard';
import { ReviewCommentCard } from './ReviewCommentCard';
import { InlineInput } from './InlineInput';
import type { ReviewAnnotation } from './review-types';

interface ScrollingDiffViewProps {
  files: FileDiff[];
  scrollToPath: string | null;
  worktreePath: string;
  /** Base branch for diff comparison (e.g. 'main', 'develop'). Undefined = auto-detect. */
  baseBranch?: string;
  searchQuery?: string;
  reviewAnnotations: ReviewAnnotation[];
  onAnnotationAdd: (annotation: ReviewAnnotation) => void;
  onAnnotationDismiss: (id: string) => void;
  onAnnotationUpdate: (id: string, comment: string) => void;
  scrollToAnnotation?: ReviewAnnotation | null;
  onScrollRef?: (el: HTMLDivElement) => void;
}

const STATUS_LABELS: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
};

const LINE_BG: Record<DiffLine['type'], string> = {
  add: 'rgba(47, 209, 152, 0.10)',
  remove: 'rgba(255, 95, 115, 0.10)',
  context: 'transparent',
};

/** Gaps with this many lines or fewer are auto-expanded instead of collapsed. */
const MIN_COLLAPSE_LINES = 5;

const INDICATOR: Record<DiffLine['type'], string> = {
  add: '+',
  remove: '-',
  context: ' ',
};

function indicatorColor(type: DiffLine['type']): string {
  if (type === 'add') return theme.success;
  if (type === 'remove') return theme.error;
  return theme.fgSubtle;
}

/** Filter items that belong to a specific hunk by checking a line number key. */
function itemsForHunk<T>(
  items: T[],
  filePath: string,
  getPath: (item: T) => string,
  getLine: (item: T) => number,
  hunkStart: number,
  nextHunkStart: number,
): T[] {
  return items.filter(
    (item) =>
      getPath(item) === filePath && getLine(item) >= hunkStart && getLine(item) < nextHunkStart,
  );
}

interface HighlightRange {
  filePath: string;
  startLine: number;
  endLine: number;
}

function isLineHighlighted(
  range: HighlightRange | null | undefined,
  filePath: string,
  newLine: number | null,
): boolean {
  return (
    !!range &&
    range.filePath === filePath &&
    newLine !== null &&
    newLine >= range.startLine &&
    newLine <= range.endLine
  );
}

interface ActiveQuestion {
  id: string;
  filePath: string;
  afterLine: number;
  question: string;
  startLine: number;
  endLine: number;
  selectedText: string;
}

// ---------------------------------------------------------------------------
// Search highlight helpers
// ---------------------------------------------------------------------------

const SEARCH_HIGHLIGHT_BG = 'rgba(255, 200, 50, 0.35)';
const CURRENT_MATCH_BG = 'rgba(100, 160, 255, 0.35)';

function highlightSearchMatches(text: string, query: string | undefined): JSX.Element {
  if (!query || query.length === 0) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: JSX.Element[] = [];
  let lastIdx = 0;
  let idx = lowerText.indexOf(lowerQuery);
  while (idx !== -1) {
    if (idx > lastIdx) parts.push(<>{text.slice(lastIdx, idx)}</>);
    parts.push(
      <mark style={{ background: SEARCH_HIGHLIGHT_BG, color: 'inherit', 'border-radius': '2px' }}>
        {text.slice(idx, idx + query.length)}
      </mark>,
    );
    lastIdx = idx + query.length;
    idx = lowerText.indexOf(lowerQuery, lastIdx);
  }
  if (lastIdx < text.length) parts.push(<>{text.slice(lastIdx)}</>);
  return <>{parts}</>;
}

function highlightSearchInHtml(html: string, query: string | undefined): string {
  if (!query || query.length === 0) return html;
  const lowerQuery = query.toLowerCase();
  // Split HTML into tags and text segments, only replace in text segments
  return html.replace(/([^<>]+)|(<[^>]*>)/g, (_match, text, tag) => {
    if (tag) return tag; // keep HTML tags unchanged
    const segment: string = text; // guaranteed defined since one of text/tag always matches
    const lowerText = segment.toLowerCase();
    let result = '';
    let lastIdx = 0;
    let idx = lowerText.indexOf(lowerQuery);
    while (idx !== -1) {
      result += segment.slice(lastIdx, idx);
      result += `<mark style="background:${SEARCH_HIGHLIGHT_BG};color:inherit;border-radius:2px">${segment.slice(idx, idx + query.length)}</mark>`;
      lastIdx = idx + query.length;
      idx = lowerText.indexOf(lowerQuery, lastIdx);
    }
    result += segment.slice(lastIdx);
    return result;
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DiffLineView(props: {
  line: DiffLine;
  highlightedHtml: string | null;
  searchQuery?: string;
  filePath: string;
  highlighted?: boolean;
}) {
  const bg = () => (props.highlighted ? CURRENT_MATCH_BG : LINE_BG[props.line.type]);

  return (
    <div
      data-file-path={props.filePath}
      data-new-line={props.line.newLine ?? undefined}
      data-line-type={props.line.type}
      style={{
        display: 'grid',
        'grid-template-columns': '40px 40px 1rem 1fr',
        background: bg(),
        'font-family': "'JetBrains Mono', monospace",
        'font-size': sf(12),
        'line-height': '1.5',
      }}
    >
      {/* Old line number */}
      <span
        style={{
          'text-align': 'right',
          color: theme.fgSubtle,
          'font-size': sf(11),
          'user-select': 'none',
          padding: '0 4px',
        }}
      >
        {props.line.oldLine ?? ''}
      </span>

      {/* New line number */}
      <span
        style={{
          'text-align': 'right',
          color: theme.fgSubtle,
          'font-size': sf(11),
          'user-select': 'none',
          padding: '0 4px',
        }}
      >
        {props.line.newLine ?? ''}
      </span>

      {/* Indicator (+/-/space) */}
      <span
        style={{
          'text-align': 'center',
          color: indicatorColor(props.line.type),
          'font-weight': '600',
          'user-select': 'none',
        }}
      >
        {INDICATOR[props.line.type]}
      </span>

      {/* Code content */}
      {props.highlightedHtml ? (
        <span
          style={{
            'white-space': 'pre-wrap',
            'overflow-wrap': 'break-word',
            'padding-right': '8px',
          }}
          // eslint-disable-next-line solid/no-innerhtml -- HTML from our own Shiki highlighter, safe
          innerHTML={highlightSearchInHtml(props.highlightedHtml, props.searchQuery)}
        />
      ) : (
        <span
          style={{
            'white-space': 'pre-wrap',
            'overflow-wrap': 'break-word',
            'padding-right': '8px',
          }}
        >
          {highlightSearchMatches(props.line.content, props.searchQuery)}
        </span>
      )}
    </div>
  );
}

function HunkView(props: {
  hunk: Hunk;
  lang: string;
  searchQuery?: string;
  filePath: string;
  highlightedRange?: HighlightRange | null;
  pendingInputAfterLine?: number | null;
  onSubmit?: (text: string, mode: 'review' | 'ask') => void;
  onDismiss?: () => void;
}) {
  const [highlighted, setHighlighted] = createSignal<string[] | null>(null);

  onMount(() => {
    const code = props.hunk.lines.map((l) => l.content).join('\n');
    highlightLines(code, props.lang)
      .then((result) => setHighlighted(result))
      .catch(() => {
        /* highlight failure is non-fatal — fallback to plain text */
      });
  });

  return (
    <For each={props.hunk.lines}>
      {(line, i) => (
        <>
          <DiffLineView
            line={line}
            highlightedHtml={highlighted()?.[i()] ?? null}
            searchQuery={props.searchQuery}
            filePath={props.filePath}
            highlighted={isLineHighlighted(props.highlightedRange, props.filePath, line.newLine)}
          />
          <Show
            when={
              props.pendingInputAfterLine !== null && line.newLine === props.pendingInputAfterLine
            }
          >
            <InlineInput
              onSubmit={(text, mode) => props.onSubmit?.(text, mode)}
              onDismiss={() => props.onDismiss?.()}
            />
          </Show>
        </>
      )}
    </For>
  );
}

/** Unified gap view for leading (before first hunk) and between-hunk gaps.
 *  startLine/endLine are 1-based (inclusive/exclusive). oldLineStart is the
 *  corresponding old-file line number for the first gap line. */
function GapView(props: {
  startLine: number;
  endLine: number;
  oldLineStart: number;
  lang: string;
  worktreePath: string;
  filePath: string;
  baseBranch?: string;
  searchQuery?: string;
  highlightedRange?: HighlightRange | null;
  borderTop?: boolean;
  borderBottom?: boolean;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const [lines, setLines] = createSignal<DiffLine[]>([]);
  const [highlighted, setHighlighted] = createSignal<string[] | null>(null);
  const [loading, setLoading] = createSignal(false);

  const hiddenCount = () => props.endLine - props.startLine;

  onMount(() => {
    if (hiddenCount() > 0 && hiddenCount() <= MIN_COLLAPSE_LINES) expand();
  });

  async function expand() {
    if (expanded() || loading()) return;
    setLoading(true);
    try {
      const result = await invoke<FileDiffResult>(IPC.GetFileDiff, {
        worktreePath: props.worktreePath,
        filePath: props.filePath,
        baseBranch: props.baseBranch,
      });
      const fileLines = result.newContent.split('\n');
      const gapLines: DiffLine[] = [];
      for (let n = props.startLine; n < props.endLine; n++) {
        gapLines.push({
          type: 'context',
          content: fileLines[n - 1] ?? '',
          oldLine: props.oldLineStart + (n - props.startLine),
          newLine: n,
        });
      }
      setLines(gapLines);
      setExpanded(true);

      const code = gapLines.map((l) => l.content).join('\n');
      highlightLines(code, props.lang)
        .then(setHighlighted)
        .catch(() => {});
    } catch {
      /* fetch failed — keep collapsed */
    } finally {
      setLoading(false);
    }
  }

  return (
    <Show when={hiddenCount() > 0}>
      <Show
        when={expanded()}
        fallback={
          <div
            onClick={expand}
            style={{
              padding: '2px 0',
              'text-align': 'center',
              color: theme.fgSubtle,
              'font-size': sf(11),
              'font-family': "'JetBrains Mono', monospace",
              background: theme.bgElevated,
              'border-top': props.borderTop ? `1px solid ${theme.borderSubtle}` : undefined,
              'border-bottom': props.borderBottom ? `1px solid ${theme.borderSubtle}` : undefined,
              'user-select': 'none',
              cursor: 'pointer',
            }}
          >
            {loading() ? 'Loading...' : `${hiddenCount()} lines hidden`}
          </div>
        }
      >
        <For each={lines()}>
          {(line, i) => (
            <DiffLineView
              line={line}
              highlightedHtml={highlighted()?.[i()] ?? null}
              searchQuery={props.searchQuery}
              filePath={props.filePath}
              highlighted={isLineHighlighted(props.highlightedRange, props.filePath, line.newLine)}
            />
          )}
        </For>
      </Show>
    </Show>
  );
}

function TrailingGap(props: {
  lastHunk: Hunk;
  lang: string;
  worktreePath: string;
  filePath: string;
  baseBranch?: string;
  searchQuery?: string;
  highlightedRange?: HighlightRange | null;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const [lines, setLines] = createSignal<DiffLine[]>([]);
  const [highlighted, setHighlighted] = createSignal<string[] | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [hiddenCount, setHiddenCount] = createSignal<number | null>(null);

  async function fetchGapLines(): Promise<DiffLine[]> {
    const result = await invoke<FileDiffResult>(IPC.GetFileDiff, {
      worktreePath: props.worktreePath,
      filePath: props.filePath,
      baseBranch: props.baseBranch,
    });
    const fileLines = result.newContent.split('\n');
    const totalLines = result.newContent.endsWith('\n') ? fileLines.length - 1 : fileLines.length;
    const startLine = props.lastHunk.newStart + props.lastHunk.newCount;
    const lastOldEnd = props.lastHunk.oldStart + props.lastHunk.oldCount;
    const gapLines: DiffLine[] = [];
    for (let n = startLine; n <= totalLines; n++) {
      gapLines.push({
        type: 'context',
        content: fileLines[n - 1] ?? '',
        oldLine: lastOldEnd + (n - startLine),
        newLine: n,
      });
    }
    return gapLines;
  }

  function showLines(gapLines: DiffLine[]) {
    setLines(gapLines);
    setExpanded(true);
    const code = gapLines.map((l) => l.content).join('\n');
    highlightLines(code, props.lang)
      .then(setHighlighted)
      .catch(() => {});
  }

  let cachedGapLines: DiffLine[] | null = null;

  onMount(async () => {
    setLoading(true);
    try {
      cachedGapLines = await fetchGapLines();
      setHiddenCount(cachedGapLines.length);
      if (cachedGapLines.length > 0 && cachedGapLines.length <= MIN_COLLAPSE_LINES) {
        showLines(cachedGapLines);
        cachedGapLines = null;
      }
    } catch {
      setHiddenCount(0);
    } finally {
      setLoading(false);
    }
  });

  async function expand() {
    if (expanded() || loading()) return;
    setLoading(true);
    try {
      const gapLines = cachedGapLines ?? (await fetchGapLines());
      cachedGapLines = null;
      if (gapLines.length === 0) {
        setHiddenCount(0);
        return;
      }
      showLines(gapLines);
    } catch {
      /* fetch failed — keep collapsed */
    } finally {
      setLoading(false);
    }
  }

  return (
    <Show when={hiddenCount() !== 0}>
      <Show
        when={expanded()}
        fallback={
          <div
            onClick={expand}
            style={{
              padding: '2px 0',
              'text-align': 'center',
              color: theme.fgSubtle,
              'font-size': sf(11),
              'font-family': "'JetBrains Mono', monospace",
              background: theme.bgElevated,
              'border-top': `1px solid ${theme.borderSubtle}`,
              'user-select': 'none',
              cursor: 'pointer',
            }}
          >
            {loading()
              ? 'Loading...'
              : hiddenCount() !== null
                ? `${hiddenCount()} lines hidden`
                : '\u00B7\u00B7\u00B7'}
          </div>
        }
      >
        <For each={lines()}>
          {(line, i) => (
            <DiffLineView
              line={line}
              highlightedHtml={highlighted()?.[i()] ?? null}
              searchQuery={props.searchQuery}
              filePath={props.filePath}
              highlighted={isLineHighlighted(props.highlightedRange, props.filePath, line.newLine)}
            />
          )}
        </For>
      </Show>
    </Show>
  );
}

function FileSection(props: {
  file: FileDiff;
  worktreePath: string;
  baseBranch?: string;
  ref: (el: HTMLDivElement) => void;
  dimmed: boolean;
  searchQuery?: string;
  activeQuestions: ActiveQuestion[];
  onDismissQuestion: (id: string) => void;
  reviewAnnotations: ReviewAnnotation[];
  onDismissAnnotation: (id: string) => void;
  onAnnotationUpdate: (id: string, comment: string) => void;
  highlightedRange?: HighlightRange | null;
  pendingInput?: { filePath: string; afterLine: number } | null;
  onSubmit: (text: string, mode: 'review' | 'ask') => void;
  onDismiss: () => void;
}) {
  const [collapsed, setCollapsed] = createSignal(false);
  const lang = () => detectLang(props.file.path);
  const added = () =>
    props.file.hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === 'add').length, 0);
  const removed = () =>
    props.file.hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === 'remove').length, 0);

  return (
    <div
      ref={props.ref}
      style={{
        margin: '16px 10px',
        border: `1px solid ${theme.border}`,
        'border-radius': '8px',
        overflow: 'hidden',
        background: theme.bgElevated,
        opacity: props.dimmed ? '0.25' : '0.9',
        transition: 'opacity 5s ease-out',
      }}
    >
      {/* Sticky file header */}
      <div
        onClick={() => setCollapsed(!collapsed())}
        style={{
          position: 'sticky',
          top: '0',
          'z-index': '1',
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          padding: '3px 10px',
          background: `color-mix(in srgb, ${theme.bgElevated} 96%, white)`,
          'border-bottom': `1px solid ${theme.border}`,
          cursor: 'pointer',
        }}
      >
        {/* Collapse indicator */}
        <span
          style={{
            color: theme.fgSubtle,
            'font-size': sf(11),
            'user-select': 'none',
            transition: 'transform 0.15s',
            transform: collapsed() ? 'rotate(-90deg)' : 'rotate(0deg)',
            display: 'inline-block',
          }}
        >
          ▾
        </span>

        {/* Status badge */}
        <span
          style={{
            'font-size': sf(11),
            'font-weight': '600',
            padding: '2px 8px',
            'border-radius': '4px',
            color: getStatusColor(props.file.status),
            background: 'rgba(255,255,255,0.06)',
          }}
        >
          {STATUS_LABELS[props.file.status] ?? props.file.status}
        </span>

        {/* File path */}
        <span
          style={{
            flex: '1',
            'font-size': sf(12),
            'font-family': "'JetBrains Mono', monospace",
            color: theme.fg,
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
          }}
        >
          {props.file.path}
        </span>

        <span
          style={{
            'font-size': sf(11),
            color: theme.success,
            'font-family': "'JetBrains Mono', monospace",
          }}
        >
          +{added()}
        </span>
        <span
          style={{
            'font-size': sf(11),
            color: theme.error,
            'font-family': "'JetBrains Mono', monospace",
          }}
        >
          -{removed()}
        </span>

        {/* Open in editor button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            openFileInEditor(props.worktreePath, props.file.path);
          }}
          disabled={!props.worktreePath}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: props.worktreePath ? 'pointer' : 'default',
            opacity: props.worktreePath ? '1' : '0.3',
            padding: '4px',
            display: 'flex',
            'align-items': 'center',
            'border-radius': '4px',
          }}
          title="Open in editor"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.5 2a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3a.75.75 0 0 1 1.5 0v3A3 3 0 0 1 12.5 16h-9A3 3 0 0 1 0 12.5v-9A3 3 0 0 1 3.5 0h3a.75.75 0 0 1 0 1.5h-3ZM10 .75a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V2.56L8.53 8.53a.75.75 0 0 1-1.06-1.06L13.44 1.5H10.75A.75.75 0 0 1 10 .75Z" />
          </svg>
        </button>
      </div>

      {/* File body */}
      <Show when={!collapsed()}>
        <Show when={props.file.binary}>
          <div
            style={{
              padding: '24px',
              'text-align': 'center',
              color: theme.fgMuted,
              'font-size': sf(12),
            }}
          >
            Binary file — cannot display diff
          </div>
        </Show>

        <Show when={!props.file.binary}>
          <div style={{ 'padding-bottom': '8px', background: 'rgba(0, 0, 0, 0.15)' }}>
            <Show when={props.file.hunks.length > 0 && props.file.status !== 'D'}>
              <GapView
                startLine={1}
                endLine={props.file.hunks[0].newStart}
                oldLineStart={1}
                lang={lang()}
                worktreePath={props.worktreePath}
                filePath={props.file.path}
                baseBranch={props.baseBranch}
                searchQuery={props.searchQuery}
                highlightedRange={props.highlightedRange}
                borderBottom
              />
            </Show>
            <For each={props.file.hunks}>
              {(hunk, hunkIdx) => (
                <>
                  <Show when={hunkIdx() > 0}>
                    <GapView
                      startLine={
                        props.file.hunks[hunkIdx() - 1].newStart +
                        props.file.hunks[hunkIdx() - 1].newCount
                      }
                      endLine={hunk.newStart}
                      oldLineStart={
                        props.file.hunks[hunkIdx() - 1].oldStart +
                        props.file.hunks[hunkIdx() - 1].oldCount
                      }
                      lang={lang()}
                      worktreePath={props.worktreePath}
                      filePath={props.file.path}
                      baseBranch={props.baseBranch}
                      searchQuery={props.searchQuery}
                      highlightedRange={props.highlightedRange}
                      borderTop
                      borderBottom
                    />
                  </Show>
                  <HunkView
                    hunk={hunk}
                    lang={lang()}
                    searchQuery={props.searchQuery}
                    filePath={props.file.path}
                    highlightedRange={props.highlightedRange}
                    pendingInputAfterLine={
                      props.pendingInput?.filePath === props.file.path
                        ? props.pendingInput.afterLine
                        : null
                    }
                    onSubmit={props.onSubmit}
                    onDismiss={props.onDismiss}
                  />
                  {(() => {
                    const nextStart = props.file.hunks[hunkIdx() + 1]?.newStart ?? Infinity;
                    return (
                      <>
                        <For
                          each={itemsForHunk(
                            props.activeQuestions,
                            props.file.path,
                            (q) => q.filePath,
                            (q) => q.afterLine,
                            hunk.newStart,
                            nextStart,
                          )}
                        >
                          {(q) => (
                            <AskCodeCard
                              requestId={q.id}
                              question={q.question}
                              filePath={q.filePath}
                              startLine={q.startLine}
                              endLine={q.endLine}
                              selectedText={q.selectedText}
                              worktreePath={props.worktreePath}
                              onDismiss={() => props.onDismissQuestion(q.id)}
                            />
                          )}
                        </For>
                        <For
                          each={itemsForHunk(
                            props.reviewAnnotations,
                            props.file.path,
                            (a) => a.filePath,
                            (a) => a.endLine,
                            hunk.newStart,
                            nextStart,
                          )}
                        >
                          {(a) => (
                            <ReviewCommentCard
                              annotation={a}
                              onDismiss={() => props.onDismissAnnotation(a.id)}
                              onUpdate={(comment) => props.onAnnotationUpdate(a.id, comment)}
                            />
                          )}
                        </For>
                      </>
                    );
                  })()}
                </>
              )}
            </For>
            <Show when={props.file.hunks.length > 0 && props.file.status !== 'D'}>
              <TrailingGap
                lastHunk={props.file.hunks[props.file.hunks.length - 1]}
                lang={lang()}
                worktreePath={props.worktreePath}
                filePath={props.file.path}
                baseBranch={props.baseBranch}
                searchQuery={props.searchQuery}
                highlightedRange={props.highlightedRange}
              />
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ScrollingDiffView(props: ScrollingDiffViewProps) {
  const sectionRefs = new Map<string, HTMLDivElement>();
  const [dimOthers, setDimOthers] = createSignal(false);
  let dimTimer: ReturnType<typeof setTimeout> | undefined;
  let containerRef: HTMLDivElement | undefined;

  const [pendingInput, setPendingInput] = createSignal<DiffSelection | null>(null);
  const [activeQuestions, setActiveQuestions] = createSignal<ActiveQuestion[]>([]);
  const [highlightedRange, setHighlightedRange] = createSignal<HighlightRange | null>(null);

  onCleanup(() => clearTimeout(dimTimer));

  /** Scroll to a file section when scrollToPath changes. */
  createEffect(() => {
    const target = props.scrollToPath;
    if (!target) return;
    clearTimeout(dimTimer);
    setDimOthers(true);
    // Start fade-in on next frame so the browser registers the dimmed state first
    requestAnimationFrame(() => setDimOthers(false));
    // Wait for DOM to settle before scrolling
    requestAnimationFrame(() => {
      const el = sectionRefs.get(target);
      if (el && containerRef) {
        const containerTop = containerRef.getBoundingClientRect().top;
        const elTop = el.getBoundingClientRect().top;
        const scrollPos = elTop - containerTop + containerRef.scrollTop - 50;
        containerRef.scrollTop = Math.max(0, scrollPos);
      }
    });
  });

  /** Scroll to first search match when query changes. */
  createEffect(() => {
    const q = props.searchQuery;
    if (!q) return;
    requestAnimationFrame(() => {
      const mark = containerRef?.querySelector('mark');
      if (mark && containerRef) {
        const containerTop = containerRef.getBoundingClientRect().top;
        const markTop = mark.getBoundingClientRect().top;
        const scrollPos = markTop - containerTop + containerRef.scrollTop - 80;
        containerRef.scrollTop = Math.max(0, scrollPos);
      }
    });
  });

  /** Scroll to a specific annotation (e.g. clicked in the sidebar). */
  createEffect(() => {
    const target = props.scrollToAnnotation;
    if (!target) return;
    const el = containerRef?.querySelector(
      `[data-file-path="${CSS.escape(target.filePath)}"][data-new-line="${target.startLine}"]`,
    );
    if (el && containerRef) {
      const containerTop = containerRef.getBoundingClientRect().top;
      const elTop = el.getBoundingClientRect().top;
      containerRef.scrollTop = elTop - containerTop + containerRef.scrollTop - 80;
    }
  });

  onMount(() => {
    function onMouseUp() {
      requestAnimationFrame(() => {
        const sel = getDiffSelection();
        if (!sel) {
          // Don't clear if user is interacting with the inline input
          if (!pendingInput()) {
            setHighlightedRange(null);
          }
          return;
        }

        setPendingInput(sel);
        setHighlightedRange({
          filePath: sel.filePath,
          startLine: sel.startLine,
          endLine: sel.endLine,
        });
      });
    }

    containerRef?.addEventListener('mouseup', onMouseUp);
    onCleanup(() => containerRef?.removeEventListener('mouseup', onMouseUp));
  });

  function handleSubmit(text: string, mode: 'review' | 'ask') {
    const sel = pendingInput();
    if (!sel) return;

    const savedScroll = containerRef?.scrollTop ?? 0;

    if (mode === 'review') {
      props.onAnnotationAdd({
        id: crypto.randomUUID(),
        filePath: sel.filePath,
        startLine: sel.startLine,
        endLine: sel.endLine,
        selectedText: sel.selectedText,
        comment: text,
      });
    } else {
      setActiveQuestions((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          filePath: sel.filePath,
          afterLine: sel.endLine,
          question: text,
          startLine: sel.startLine,
          endLine: sel.endLine,
          selectedText: sel.selectedText,
        },
      ]);
    }
    setPendingInput(null);
    setHighlightedRange(null);
    window.getSelection()?.removeAllRanges();

    requestAnimationFrame(() => {
      if (containerRef) containerRef.scrollTop = savedScroll;
    });
  }

  function dismissInput() {
    setPendingInput(null);
    setHighlightedRange(null);
  }

  function dismissQuestion(id: string) {
    setActiveQuestions((prev) => prev.filter((q) => q.id !== id));
  }

  return (
    <div
      ref={(el) => {
        containerRef = el;
        props.onScrollRef?.(el);
      }}
      style={{
        height: '100%',
        'overflow-y': 'auto',
        background: theme.bg,
        position: 'relative',
      }}
    >
      <For each={props.files}>
        {(file) => (
          <FileSection
            file={file}
            worktreePath={props.worktreePath}
            baseBranch={props.baseBranch}
            ref={(el) => sectionRefs.set(file.path, el)}
            dimmed={dimOthers() && file.path !== props.scrollToPath}
            searchQuery={props.searchQuery}
            activeQuestions={activeQuestions()}
            onDismissQuestion={dismissQuestion}
            reviewAnnotations={props.reviewAnnotations}
            onDismissAnnotation={props.onAnnotationDismiss}
            onAnnotationUpdate={props.onAnnotationUpdate}
            highlightedRange={highlightedRange()}
            pendingInput={(() => {
              const pi = pendingInput();
              return pi && pi.filePath === file.path
                ? { filePath: file.path, afterLine: pi.endLine }
                : null;
            })()}
            onSubmit={handleSubmit}
            onDismiss={dismissInput}
          />
        )}
      </For>

      <Show when={props.files.length === 0}>
        <div
          style={{
            padding: '40px',
            'text-align': 'center',
            color: theme.fgMuted,
            'font-size': sf(12),
          }}
        >
          No changes to display
        </div>
      </Show>
    </div>
  );
}
