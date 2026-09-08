import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  untrack,
  type JSX,
} from 'solid-js';
import { CandidateRefinement } from './CandidateRefinement';
import { MergeWithAgent } from './MergeWithAgent';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { diffBlocks, type BlockChange, type DocumentBlock } from './markdown-blocks';
import {
  type BlockHunk,
  blockHunks,
  composeVerifiedDocument,
  hunkLabel,
  hunkLeadBlocks,
} from './block-merge';
import {
  acceptDocumentCandidate,
  documentStore,
  modelLabel,
  setDocumentCandidateNote,
} from './store';
import { RejectRunButton } from './RejectRunConfirm';
import { getProject } from '../store/projects';
import { deletePanelUserSize, getPanelUserSize, setPanelUserSize } from '../store/store';
import { showNotification } from '../store/notification';
import type { DocumentCandidateRecord, DocumentRunRecord } from './types';
import { DocumentViewer, type BlockRange } from './DocumentViewer';
import { SourceDiff } from './SourceDiff';
import { createRenderedBlocks } from './use-blocks';
import { renderDocument } from './render-document';

function projectRoot(): string {
  const project = documentStore.projectId ? getProject(documentStore.projectId) : undefined;
  return project?.path ?? '';
}

async function fetchDocumentAt(sha: string, documentPath: string): Promise<string | null> {
  return invoke<string | null>(IPC.GetDocumentAtCommit, {
    projectRoot: projectRoot(),
    sha,
    documentPath,
  });
}

/** Blocks that lie inside the run's line scope at the base commit. */
function scopeRange(blocks: readonly DocumentBlock[], run: DocumentRunRecord): BlockRange | null {
  if (run.scope.wholeDocument || blocks.length === 0) return null;
  let start = -1;
  let end = -1;
  blocks.forEach((b, i) => {
    if (b.endLine >= run.scope.startLine && b.startLine <= run.scope.endLine) {
      if (start === -1) start = i;
      end = i;
    }
  });
  return start === -1 ? null : { start, end };
}

/**
 * Scroll a column so its first block matching `selector` sits in the upper
 * third. False when there is no such block yet.
 */
function revealFirst(body: HTMLElement | undefined, selector: string): boolean {
  const target = body?.querySelector<HTMLElement>(selector);
  if (!body || !target) return false;
  const offset = target.getBoundingClientRect().top - body.getBoundingClientRect().top;
  body.scrollTop += offset - body.clientHeight / 3;
  return true;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function reviewBlocks(
  hunks: readonly BlockHunk[],
  side: 'base' | 'cand',
  count: number,
): Set<number> {
  const visible = new Set<number>();
  for (const hunk of hunks) {
    const start = hunk[side === 'base' ? 'baseStart' : 'candStart'];
    const end = hunk[side === 'base' ? 'baseEnd' : 'candEnd'];
    for (let i = start; i < end; i++) visible.add(i);
    if (start === end && count > 0) visible.add(Math.min(start, count - 1));
  }
  return visible;
}

function ChangeNav(props: {
  body: () => HTMLDivElement | undefined;
  baseBody: () => HTMLDivElement | undefined;
  hunks: BlockHunk[];
  baseCount: number;
  candidateCount: number;
}) {
  const [cursor, setCursor] = createSignal(-1);
  function go(delta: number) {
    const count = props.hunks.length;
    if (!count) return;
    const next = cursor() < 0 ? (delta > 0 ? 0 : count - 1) : (cursor() + delta + count) % count;
    setCursor(next);
    const hunk = props.hunks[next];
    const reveal = (body: HTMLElement | undefined, index: number) =>
      body?.querySelector<HTMLElement>(`[data-block-index="${index}"]`)?.scrollIntoView({
        block: 'center',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
    reveal(props.baseBody(), Math.min(hunk.baseStart, props.baseCount - 1));
    reveal(props.body(), Math.min(hunk.candStart, props.candidateCount - 1));
  }
  return (
    <span class="docws-nav">
      <button
        type="button"
        class="docws-btn docws-btn-sm"
        disabled={!props.hunks.length}
        onClick={() => go(-1)}
        title="Previous change"
        aria-label="Previous change"
      >
        ‹
      </button>
      <span>
        {cursor() < 0 ? '' : `${cursor() + 1} of `}
        {plural(props.hunks.length, 'change')}
      </span>
      <button
        type="button"
        class="docws-btn docws-btn-sm"
        disabled={!props.hunks.length}
        onClick={() => go(1)}
        title="Next change"
        aria-label="Next change"
      >
        ›
      </button>
    </span>
  );
}

function Rationale(props: { candidate: DocumentCandidateRecord; children: JSX.Element }) {
  const r = () => props.candidate.rationale;
  const list = (label: string, items: string[] | undefined, cls?: string) => (
    <Show when={items && items.length > 0}>
      <div class="docws-rationale-label">{label}</div>
      <ul class={cls}>
        <For each={items}>{(item) => <li>{item}</li>}</For>
      </ul>
    </Show>
  );
  return (
    <div class="docws-rationale">
      <div class="docws-rationale-summary" title={r()?.summary}>
        {r()?.summary ?? 'No rationale returned.'}
      </div>
      <details class="docws-review-details">
        <summary>Reasoning and notes</summary>
        <div class="docws-review-details-body">
          <p>{r()?.summary ?? 'No rationale returned.'}</p>
          {list('Changes', r()?.changes)}
          {list('Assumptions', r()?.assumptions)}
          {list('Open questions', r()?.questions)}
          {props.children}
        </div>
      </details>
      {list('Warnings', r()?.warnings, 'docws-warning')}
      <Show when={props.candidate.outOfScopeFiles?.length}>
        <div class="docws-warning">
          Touched files outside the document (reverted):{' '}
          {props.candidate.outOfScopeFiles?.join(', ')}
        </div>
      </Show>
      <Show when={props.candidate.outOfScopeHunks}>
        <div class="docws-warning">
          {props.candidate.outOfScopeHunks} change{props.candidate.outOfScopeHunks === 1 ? '' : 's'}{' '}
          outside the selected passage.
        </div>
      </Show>
      <Show when={props.candidate.error}>
        <div class="docws-error">{props.candidate.error}</div>
      </Show>
    </div>
  );
}

/** Narrower than this a column reads as a sliver, whatever the reader drags. */
const MIN_COLUMN_WIDTH = 260;

/* Keyed by position rather than by candidate: a column width is a layout
   preference, so it holds as the reader moves from one run to the next. */
const columnKey = (column: string) => `docws-compare:${column}`;

/**
 * The seam on a column's right edge: drag it to size the column it follows,
 * double-click to hand the width back to the layout.
 *
 * `ResizablePanel` is the app's splitter, but it puts `overflow: hidden` on the
 * row and on every cell. This row scrolls sideways instead, so a column made
 * wide pushes its neighbours along rather than clipping them out of reach.
 */
function ColumnSeam(props: {
  /** True while this seam is the one under the pointer. */
  dragging: boolean;
  /** The width under the pointer, reported for as long as the drag lasts. */
  onDrag: (width: number) => void;
  onRelease: () => void;
  onReset: () => void;
}) {
  let seam: HTMLDivElement | undefined;
  /** The listeners of the drag in flight, so an unmount can take them down too. */
  let live: { move: (e: MouseEvent) => void; up: () => void } | undefined;

  function detach() {
    if (!live) return;
    window.removeEventListener('mousemove', live.move);
    window.removeEventListener('mouseup', live.up);
    live = undefined;
  }
  onCleanup(detach);

  function begin(e: MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    // The column this seam sizes is the one it sits behind in the row.
    const column = seam?.previousElementSibling;
    if (!column?.classList.contains('docws-column')) return;
    const startX = e.clientX;
    const startWidth = column.getBoundingClientRect().width;
    const move = (ev: MouseEvent) =>
      props.onDrag(Math.max(MIN_COLUMN_WIDTH, startWidth + ev.clientX - startX));
    const up = () => {
      detach();
      props.onRelease();
    };
    live = { move, up };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  return (
    <div
      ref={seam}
      class="resize-handle resize-handle-h"
      classList={{ dragging: props.dragging }}
      title="Drag to resize · double-click to reset"
      onMouseDown={begin}
      onDblClick={() => props.onReset()}
    />
  );
}

function CandidateColumn(props: {
  run: DocumentRunRecord;
  candidate: DocumentCandidateRecord;
  baseBlocks: DocumentBlock[];
  baseSource: string;
  /** False for HTML pages, whose blocks the composer cannot splice back together. */
  partialCapable: boolean;
  revealAgents: boolean;
  showSource: boolean;
  changesOnly: boolean;
  baseBody: () => HTMLDivElement | undefined;
  hidden: boolean;
  panelId: string;
  tabId?: string;
  /** Reports which base blocks this candidate changed or removed. */
  onBaseChanges: (candidateId: string, changes: BlockChange[], hunks: BlockHunk[]) => void;
  /** Width the reader dragged this column to, if any. */
  style?: JSX.CSSProperties;
}) {
  let bodyRef: HTMLDivElement | undefined;
  const [content] = createResource(
    () =>
      props.candidate.commitSha
        ? { sha: props.candidate.commitSha, path: props.run.documentPath }
        : null,
    ({ sha, path }) => fetchDocumentAt(sha, path),
  );
  const rendered = createRenderedBlocks(() => content() ?? null);
  const blockDiff = createMemo(() => diffBlocks(props.baseBlocks, rendered.blocks()));
  const changes = () => blockDiff().candidate;
  const changedCount = () => changes().filter((c) => c !== 'same').length;
  createEffect(() => {
    if (rendered.blocks().length > 0)
      props.onBaseChanges(props.candidate.id, blockDiff().base, blockHunks(blockDiff()));
  });
  // Hidden tabs have no layout. Reveal the first change once the proposal is
  // visible, then preserve the reader's position when switching tabs.
  let revealed = false;
  createEffect(
    on([changedCount, () => props.hidden], ([count, hidden]) => {
      if (count === 0 || hidden || revealed) return;
      const frame = requestAnimationFrame(() => {
        revealFirst(bodyRef, '.doc-block:not([data-change="same"])');
        revealed = true;
      });
      onCleanup(() => cancelAnimationFrame(frame));
    }),
  );
  const [diff] = createResource(
    () =>
      props.showSource && props.candidate.commitSha
        ? {
            projectRoot: projectRoot(),
            from: props.run.baseSha,
            to: props.candidate.commitSha,
            documentPath: props.run.documentPath,
          }
        : null,
    (args) => invoke<string>(IPC.GetDocumentDiff, args),
  );
  // Partial acceptance: every change is kept until the reader declines it, so
  // the default is exactly the whole-candidate acceptance it replaces.
  const hunks = createMemo(() => blockHunks(blockDiff()));
  const visible = createMemo(() => reviewBlocks(hunks(), 'cand', rendered.blocks().length));
  const leads = createMemo(() => hunkLeadBlocks(hunks(), rendered.blocks().length));
  const partial = createMemo(
    () => props.partialCapable && !rendered.page() && hunks().length > 1 && !!leads(),
  );
  const [declined, setDeclined] = createSignal<ReadonlySet<number>>(new Set<number>());
  // Reset on the shape of the changes, not on the memo's identity: the run
  // object is replaced whenever anything about it is saved — writing a note on
  // this very candidate does it — and resetting then would silently re-accept
  // passages the reader had declined.
  const hunkShape = createMemo(() =>
    hunks()
      .map((h) => `${h.baseStart}-${h.baseEnd}-${h.candStart}-${h.candEnd}`)
      .join('|'),
  );
  createEffect(on(hunkShape, () => setDeclined(new Set<number>())));
  const keptCount = () => hunks().length - declined().size;
  function toggleHunk(id: number) {
    if (accepting()) return;
    setDeclined((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }
  // Blocks of a declined change are still shown — you are choosing against
  // them, so they have to stay readable — but marked as not landing.
  const declinedBlocks = createMemo(() => {
    const out = new Set<number>();
    if (!partial()) return out;
    for (const hunk of hunks()) {
      if (!declined().has(hunk.id)) continue;
      for (let i = hunk.candStart; i < hunk.candEnd; i++) out.add(i);
    }
    return out;
  });
  const hunkLeads = (index: number) => {
    // Gone while the acceptance runs: a toggle that no longer acts would still
    // flip on screen, and come back out of step with what was sent.
    if (!partial() || accepting()) return [];
    return (leads()?.get(index) ?? []).map((hunk) => ({
      id: hunk.id,
      accepted: !declined().has(hunk.id),
      label: hunkLabel(hunk, props.baseBlocks),
    }));
  };

  const [note, setNote] = createSignal(untrack(() => props.candidate.note ?? ''));
  const [accepting, setAccepting] = createSignal(false);
  const canAccept = () =>
    !!props.candidate.commitSha &&
    props.run.status === 'finished' &&
    !accepting() &&
    (!partial() || keptCount() > 0) &&
    (declined().size === 0 || (!composed.loading && typeof composed() === 'string'));
  const title = () =>
    props.revealAgents
      ? [
          props.candidate.agentName,
          modelLabel(props.candidate),
          props.candidate.isMain ? 'main session' : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : `Candidate ${props.candidate.label}`;

  /**
   * Declining nothing is the whole candidate, which git merges as before.
   * Anything else is composed here and sent as content: the base with the kept
   * changes spliced in. A composition that cannot be verified falls back to
   * refusing rather than writing a document nobody chose.
   */
  const [composed] = createResource(
    () => {
      const source = content();
      if (!partial() || declined().size === 0 || typeof source !== 'string') return null;
      return {
        baseSource: props.baseSource,
        baseBlocks: props.baseBlocks,
        candidateSource: source,
        candidateBlocks: rendered.blocks(),
        hunks: hunks(),
        accepted: new Set(
          hunks()
            .filter((h) => !declined().has(h.id))
            .map((h) => h.id),
        ),
      };
    },
    (args) => composeVerifiedDocument(args).catch(() => null),
  );
  const [showPreview, setShowPreview] = createSignal(false);
  const previewing = () => showPreview() && declined().size > 0;
  const [preview] = createResource(
    () => (previewing() && !composed.loading ? composed() : null),
    (source) => renderDocument(source).catch(() => null),
  );

  async function accept() {
    if (!canAccept()) return;
    setAccepting(true);
    try {
      if (declined().size === 0) {
        await acceptDocumentCandidate(props.run.id, props.candidate.id);
        return;
      }
      const result = composed();
      if (typeof result !== 'string') {
        showNotification(
          'The changes you picked cannot be combined cleanly. Accept the candidate whole, or refine it.',
        );
        return;
      }
      await acceptDocumentCandidate(props.run.id, props.candidate.id, {
        content: result,
        accepted: keptCount(),
        total: hunks().length,
      });
    } finally {
      setAccepting(false);
    }
  }

  return (
    <section
      class="docws-column"
      style={props.style}
      aria-label={title()}
      hidden={props.hidden}
      id={props.panelId}
      role={props.tabId ? 'tabpanel' : undefined}
      aria-labelledby={props.tabId}
      tabIndex={props.tabId ? 0 : undefined}
    >
      <div class="docws-column-head">
        <div class="docws-column-title">
          <span class="docws-candidate-label">{props.candidate.label}</span>
          <span>{title()}</span>
          <span style={{ 'margin-left': 'auto' }}>
            <Show when={!previewing() && !props.showSource}>
              <ChangeNav
                body={() => bodyRef}
                baseBody={props.baseBody}
                hunks={hunks()}
                baseCount={props.baseBlocks.length}
                candidateCount={rendered.blocks().length}
              />
            </Show>
          </span>
        </div>
        <Rationale candidate={props.candidate}>
          <textarea
            class="docws-note"
            placeholder="Your note on this candidate…"
            value={note()}
            onInput={(e) => setNote(e.currentTarget.value)}
            onBlur={() => {
              if (note() !== (props.candidate.note ?? ''))
                void setDocumentCandidateNote(props.run.id, props.candidate.id, note());
            }}
          />
        </Rationale>
        <CandidateRefinement run={props.run} candidate={props.candidate} />
      </div>
      <div class="docws-column-body" ref={bodyRef}>
        <Show
          when={previewing()}
          fallback={
            <Show
              when={props.candidate.commitSha}
              fallback={<div class="docws-empty">No change proposed.</div>}
            >
              <Show
                when={!props.showSource}
                fallback={
                  <Show
                    when={!diff.loading}
                    fallback={<div class="docws-empty">Loading diff…</div>}
                  >
                    <SourceDiff raw={diff() ?? ''} />
                  </Show>
                }
              >
                <Show
                  when={!rendered.rendering() || rendered.blocks().length > 0}
                  fallback={<div class="docws-empty">Rendering…</div>}
                >
                  <DocumentViewer
                    blocks={rendered.blocks()}
                    changes={changes()}
                    visibleBlock={
                      props.changesOnly && !rendered.page() ? (i) => visible().has(i) : undefined
                    }
                    hunkLeads={hunkLeads}
                    onToggleHunk={toggleHunk}
                    declined={(i) => declinedBlocks().has(i)}
                    renderKey={`cand-${props.candidate.id}`}
                    page={rendered.page()}
                  />
                </Show>
              </Show>
            </Show>
          }
        >
          <section aria-label="Result preview" aria-busy={composed.loading || preview.loading}>
            <div class="docws-rationale">
              Result with {keptCount()} of {hunks().length} changes. Unselected passages keep their
              base text. Acceptance requires the document to be unchanged since this run.
            </div>
            <Show
              when={!composed.loading && !preview.loading}
              fallback={<div class="docws-empty">Preparing preview…</div>}
            >
              <Show
                when={typeof composed() === 'string' ? preview() : null}
                fallback={
                  <div class="docws-empty">
                    Preview unavailable. Return to changes to adjust your choices.
                  </div>
                }
              >
                {(result) => (
                  <DocumentViewer
                    blocks={result().blocks}
                    page={result().page}
                    renderKey={`result-${props.candidate.id}`}
                  />
                )}
              </Show>
            </Show>
          </section>
        </Show>
      </div>
      <div class="docws-column-actions">
        <div class="docws-run-actions">
          <Show when={partial() && declined().size > 0}>
            <button
              type="button"
              class="docws-btn docws-btn-sm"
              aria-pressed={previewing()}
              onClick={() => setShowPreview((value) => !value)}
            >
              {previewing() ? 'Back to changes' : 'Preview result'}
            </button>
          </Show>
          <button
            type="button"
            class="docws-btn docws-btn-sm docws-btn-primary"
            disabled={!canAccept()}
            title={
              props.run.status === 'stale'
                ? 'The document moved since this run and the proposal no longer applies. Re-run it.'
                : declined().size === 0
                  ? 'Apply this proposal to your document'
                  : 'Apply the selected changes to your document'
            }
            onClick={() => void accept()}
          >
            {accepting()
              ? 'Applying…'
              : declined().size === 0
                ? 'Apply proposal'
                : `Apply ${keptCount()} of ${hunks().length} changes`}
          </button>
        </div>
        <Show when={declined().size > 0 && !composed.loading && composed() === null}>
          <div class="docws-error" role="alert">
            These changes cannot be combined cleanly. Adjust your choices or refine the candidate.
          </div>
        </Show>
      </div>
    </section>
  );
}

/** Base on the left, candidates to the right, each opening with its rationale. */
export function CompareView(props: { run: DocumentRunRecord; candidateId?: string }) {
  const id = createUniqueId();
  const [showAll, setShowAll] = createSignal(false);
  const [selectedId, setSelectedId] = createSignal<string>();
  createEffect(
    on(
      () => props.candidateId,
      (value) => setSelectedId(value),
    ),
  );
  let baseBodyRef: HTMLDivElement | undefined;
  let mergeButton: HTMLButtonElement | undefined;
  const [revealAgents, setRevealAgents] = createSignal(false);
  const [showSource, setShowSource] = createSignal(false);
  const [changesOnly, setChangesOnly] = createSignal(false);
  const [merging, setMerging] = createSignal(false);
  const [baseContent] = createResource(
    () => ({ sha: props.run.baseSha, path: props.run.documentPath }),
    ({ sha, path }) => fetchDocumentAt(sha, path),
  );
  const base = createRenderedBlocks(() => baseContent() ?? null);
  const scope = createMemo(() => scopeRange(base.blocks(), props.run));
  const candidates = createMemo(() => props.run.candidates.filter((c) => c.commitSha));
  const selected = createMemo(
    () => candidates().find((c) => c.id === selectedId()) ?? candidates()[0],
  );
  function navigateProposal(e: KeyboardEvent, index: number) {
    let next: number;
    if (e.key === 'ArrowRight') next = (index + 1) % candidates().length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + candidates().length) % candidates().length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = candidates().length - 1;
    else return;
    e.preventDefault();
    setSelectedId(candidates()[next].id);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  }
  const canMerge = () =>
    (props.run.status === 'finished' || props.run.status === 'stale') &&
    candidates().filter((c) => c.status === 'done').length >= 2;
  // Base blocks touched by any candidate, so a deleted paragraph is visible somewhere.
  const [baseChanges, setBaseChanges] = createSignal<Record<string, BlockChange[]>>({});
  const [baseHunks, setBaseHunks] = createSignal<Record<string, BlockHunk[]>>({});
  const baseVisible = createMemo(() =>
    reviewBlocks(
      showAll() ? Object.values(baseHunks()).flat() : (baseHunks()[selected()?.id ?? ''] ?? []),
      'base',
      base.blocks().length,
    ),
  );
  const filtering = () => changesOnly() && !base.page() && !showSource();
  // The width under the pointer while a seam is dragged. It is kept out of the
  // store on purpose: panel sizes are part of the persisted snapshot, so
  // writing one per mouse event would serialise the whole app state per frame.
  const [drag, setDrag] = createSignal<{ column: string; width: number } | null>(null);

  /** A column the reader sized keeps that width over the layout's. */
  function columnStyle(column: string): JSX.CSSProperties | undefined {
    if (!showAll()) return undefined;
    const live = drag();
    const width = live?.column === column ? live.width : getPanelUserSize(columnKey(column));
    if (!width) return undefined;
    return { flex: `0 0 ${width}px`, 'min-width': `${width}px`, 'max-width': `${width}px` };
  }

  /** The seam that sizes `column`, drawn on that column's right edge. */
  const seam = (column: string) => (
    <ColumnSeam
      dragging={drag()?.column === column}
      onDrag={(width) => setDrag({ column, width })}
      onRelease={() => {
        const live = drag();
        if (live) setPanelUserSize(columnKey(live.column), live.width);
        setDrag(null);
      }}
      onReset={() => deletePanelUserSize([columnKey(column)])}
    />
  );
  const baseMarks = createMemo<BlockChange[]>(() => {
    const perCandidate = showAll()
      ? Object.values(baseChanges())
      : [baseChanges()[selected()?.id ?? ''] ?? []];
    return base.blocks().map((_, i) => {
      const marks = perCandidate.map((m) => m[i]).filter((m): m is BlockChange => !!m);
      if (marks.includes('removed')) return 'removed';
      if (marks.includes('changed')) return 'changed';
      return 'same';
    });
  });
  // The base opens on the passage the run was scoped to, level with the
  // candidates. A whole-document run has no scope, so its base waits for the
  // first candidate to report the blocks it touched — and then holds still,
  // rather than jumping each time the reader switches proposals.
  let baseRevealed = false;
  createEffect(
    on([scope, () => base.blocks().length, baseMarks], () => {
      if (baseRevealed) return;
      const frame = requestAnimationFrame(() => {
        baseRevealed = revealFirst(
          baseBodyRef,
          '.doc-block.is-scope, .doc-block:not([data-change="same"])',
        );
      });
      onCleanup(() => cancelAnimationFrame(frame));
    }),
  );
  const scopeText = () => {
    const s = props.run.scope;
    if (s.wholeDocument) return 'whole document';
    return `L${s.startLine}–${s.endLine}${s.heading ? ` · ${s.heading}` : ''}`;
  };

  return (
    <div class="docws-compare">
      <div class="docws-compare-bar">
        <span class="docws-instruction" title={props.run.instruction}>
          “{props.run.instruction}”
        </span>
        <span>{scopeText()}</span>
        <span>base {props.run.baseSha.slice(0, 7)}</span>
        <Show when={props.run.status === 'stale'}>
          <span class="docws-warning">stale: the document moved since this run</span>
        </Show>
        <span style={{ 'margin-left': 'auto' }} />
        <label class="docws-toggle">
          <input
            type="checkbox"
            checked={revealAgents()}
            onChange={(e) => setRevealAgents(e.currentTarget.checked)}
          />
          Show agents
        </label>
        <label class="docws-toggle">
          <input
            type="checkbox"
            checked={showSource()}
            onChange={(e) => setShowSource(e.currentTarget.checked)}
          />
          Source diff
        </label>
        <label
          class="docws-toggle"
          title={
            base.page() || showSource()
              ? 'Available for rendered Markdown'
              : 'Hide unchanged passages'
          }
        >
          <input
            type="checkbox"
            aria-label="Changes only"
            checked={filtering()}
            disabled={!!base.page() || showSource()}
            onChange={(e) => setChangesOnly(e.currentTarget.checked)}
          />
          Changes only
        </label>
        <Show when={canMerge()}>
          <button
            ref={mergeButton}
            type="button"
            class="docws-btn docws-btn-sm"
            aria-expanded={merging()}
            title="Let an agent read the proposals and draft one merged version"
            onClick={() => setMerging((value) => !value)}
          >
            Merge with agent
          </button>
        </Show>
        <RejectRunButton run={props.run} label="Reject all" />
      </div>
      <Show when={merging() && canMerge()}>
        <MergeWithAgent
          run={props.run}
          revealAgents={revealAgents()}
          onClose={() => {
            setMerging(false);
            mergeButton?.focus();
          }}
        />
      </Show>
      <Show when={candidates().length > 1}>
        <div class="docws-proposal-switcher">
          <Show when={!showAll()}>
            <div class="docws-tabs" role="tablist" aria-label="Proposals">
              <Index each={candidates()}>
                {(candidate, i) => (
                  <button
                    type="button"
                    class="docws-tab"
                    role="tab"
                    id={`${id}-tab-${i}`}
                    aria-controls={`${id}-panel-${i}`}
                    aria-selected={selected()?.id === candidate().id}
                    tabIndex={selected()?.id === candidate().id ? 0 : -1}
                    onClick={() => setSelectedId(candidate().id)}
                    onKeyDown={(e) => navigateProposal(e, i)}
                  >
                    Proposal {candidate().label}
                  </button>
                )}
              </Index>
            </div>
          </Show>
          <button
            type="button"
            class="docws-btn docws-btn-sm"
            aria-pressed={showAll()}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll() ? 'Show one proposal' : 'Show all proposals'}
          </button>
        </div>
      </Show>
      <div class="docws-columns" classList={{ 'is-focused': !showAll() }}>
        <section
          class="docws-column docws-column-base"
          style={columnStyle('base')}
          aria-label="Base version"
        >
          <div class="docws-column-head">
            <div class="docws-column-title">Original</div>
            <div class="docws-rationale">
              <div>
                The document as every candidate saw it. The scoped passage is outlined; blocks a
                proposal rewrote or removed are marked.
              </div>
            </div>
          </div>
          <div class="docws-column-body" ref={baseBodyRef}>
            <DocumentViewer
              blocks={base.blocks()}
              scope={scope()}
              changes={baseMarks()}
              visibleBlock={filtering() ? (i) => baseVisible().has(i) : undefined}
              renderKey="base"
              page={base.page()}
            />
          </div>
        </section>
        <Show when={showAll()}>{seam('base')}</Show>
        <Index each={candidates()}>
          {(candidate, i) => (
            <>
              <CandidateColumn
                run={props.run}
                candidate={candidate()}
                hidden={!showAll() && selected()?.id !== candidate().id}
                panelId={`${id}-panel-${i}`}
                tabId={!showAll() && candidates().length > 1 ? `${id}-tab-${i}` : undefined}
                baseBlocks={base.blocks()}
                baseSource={baseContent() ?? ''}
                partialCapable={!base.page()}
                revealAgents={revealAgents()}
                showSource={showSource()}
                changesOnly={filtering()}
                baseBody={() => baseBodyRef}
                onBaseChanges={(id, marks, hunks) => {
                  setBaseChanges((prev) => ({ ...prev, [id]: marks }));
                  setBaseHunks((prev) => ({ ...prev, [id]: hunks }));
                }}
                style={columnStyle(`candidate-${i}`)}
              />
              <Show when={showAll()}>{seam(`candidate-${i}`)}</Show>
            </>
          )}
        </Index>
      </div>
    </div>
  );
}
