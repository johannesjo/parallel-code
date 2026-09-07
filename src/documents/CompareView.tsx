import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  untrack,
  type JSX,
} from 'solid-js';
import { CandidateRefinement } from './CandidateRefinement';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { diffBlocks, type BlockChange, type DocumentBlock } from './markdown-blocks';
import { blockHunks, composeVerifiedDocument, hunkLabel, hunkLeadBlocks } from './block-merge';
import {
  acceptDocumentCandidate,
  documentStore,
  modelLabel,
  rejectDocumentRun,
  setDocumentCandidateNote,
} from './store';
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

/** Scroll a column so its first block matching `selector` sits in the upper third. */
function revealFirst(body: HTMLElement | undefined, selector: string): void {
  const target = body?.querySelector<HTMLElement>(selector);
  if (!body || !target) return;
  const offset = target.getBoundingClientRect().top - body.getBoundingClientRect().top;
  body.scrollTop += offset - body.clientHeight / 3;
}

function ChangeNav(props: { body: () => HTMLDivElement | undefined; count: number }) {
  const [cursor, setCursor] = createSignal(-1);
  function go(delta: number) {
    const body = props.body();
    if (!body) return;
    const targets = body.querySelectorAll<HTMLElement>('.doc-block:not([data-change="same"])');
    if (targets.length === 0) return;
    const next = (cursor() + delta + targets.length) % targets.length;
    setCursor(next);
    targets[next].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  return (
    <span class="docws-nav">
      <button
        type="button"
        class="docws-btn docws-btn-sm"
        onClick={() => go(-1)}
        title="Previous change"
      >
        ‹
      </button>
      <span>
        {props.count} changed block{props.count === 1 ? '' : 's'}
      </span>
      <button
        type="button"
        class="docws-btn docws-btn-sm"
        onClick={() => go(1)}
        title="Next change"
      >
        ›
      </button>
    </span>
  );
}

function Rationale(props: { candidate: DocumentCandidateRecord }) {
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
      <div class="docws-rationale-summary">{r()?.summary ?? 'No rationale returned.'}</div>
      {list('Changes', r()?.changes)}
      {list('Assumptions', r()?.assumptions)}
      {list('Open questions', r()?.questions)}
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
  /** Reports which base blocks this candidate changed or removed. */
  onBaseChanges: (candidateId: string, changes: BlockChange[]) => void;
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
    if (rendered.blocks().length > 0) props.onBaseChanges(props.candidate.id, blockDiff().base);
  });
  // Open on the first changed block: the decision is there, not at the title.
  createEffect(
    on(changedCount, (count) => {
      if (count === 0) return;
      requestAnimationFrame(() => revealFirst(bodyRef, '.doc-block:not([data-change="same"])'));
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
    if (!partial()) return [];
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
    <section class="docws-column" style={props.style} aria-label={title()}>
      <div class="docws-column-head">
        <div class="docws-column-title">
          <span class="docws-candidate-label">{props.candidate.label}</span>
          <span>{title()}</span>
          <span style={{ 'margin-left': 'auto' }}>
            <Show when={!previewing()}>
              <ChangeNav body={() => bodyRef} count={changedCount()} />
            </Show>
          </span>
        </div>
        <Rationale candidate={props.candidate} />
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
                  ? 'Accept this candidate as one commit on the canonical branch'
                  : 'Accept the changes you kept as one commit on the canonical branch'
            }
            onClick={() => void accept()}
          >
            {accepting()
              ? 'Accepting…'
              : declined().size === 0
                ? 'Accept this candidate'
                : `Accept ${keptCount()} of ${hunks().length} changes`}
          </button>
        </div>
        <Show when={declined().size > 0 && !composed.loading && composed() === null}>
          <div class="docws-error" role="alert">
            These changes cannot be combined cleanly. Adjust your choices or refine the candidate.
          </div>
        </Show>
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
    </section>
  );
}

/** Base on the left, candidates to the right, each opening with its rationale. */
export function CompareView(props: { run: DocumentRunRecord }) {
  let baseBodyRef: HTMLDivElement | undefined;
  const [revealAgents, setRevealAgents] = createSignal(false);
  const [showSource, setShowSource] = createSignal(false);
  const [baseContent] = createResource(
    () => ({ sha: props.run.baseSha, path: props.run.documentPath }),
    ({ sha, path }) => fetchDocumentAt(sha, path),
  );
  const base = createRenderedBlocks(() => baseContent() ?? null);
  const scope = createMemo(() => scopeRange(base.blocks(), props.run));
  const candidates = createMemo(() => props.run.candidates.filter((c) => c.commitSha));
  // Base blocks touched by any candidate, so a deleted paragraph is visible somewhere.
  const [baseChanges, setBaseChanges] = createSignal<Record<string, BlockChange[]>>({});
  // The width under the pointer while a seam is dragged. It is kept out of the
  // store on purpose: panel sizes are part of the persisted snapshot, so
  // writing one per mouse event would serialise the whole app state per frame.
  const [drag, setDrag] = createSignal<{ column: string; width: number } | null>(null);

  /** A column the reader sized keeps that width over the layout's. */
  function columnStyle(column: string): JSX.CSSProperties | undefined {
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
    const perCandidate = Object.values(baseChanges());
    return base.blocks().map((_, i) => {
      const marks = perCandidate.map((m) => m[i]).filter((m): m is BlockChange => !!m);
      if (marks.includes('removed')) return 'removed';
      if (marks.includes('changed')) return 'changed';
      return 'same';
    });
  });
  // The base opens on the passage the run was scoped to, level with the candidates.
  createEffect(
    on([scope, () => base.blocks().length], () => {
      requestAnimationFrame(() =>
        revealFirst(baseBodyRef, '.doc-block.is-scope, .doc-block:not([data-change="same"])'),
      );
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
        <button
          type="button"
          class="docws-btn docws-btn-sm docws-btn-danger"
          onClick={() => void rejectDocumentRun(props.run.id)}
        >
          Reject all
        </button>
      </div>
      <div class="docws-columns">
        <section
          class="docws-column docws-column-base"
          style={columnStyle('base')}
          aria-label="Base version"
        >
          <div class="docws-column-head">
            <div class="docws-column-title">Base · {props.run.baseSha.slice(0, 7)}</div>
            <div class="docws-rationale">
              <div>
                The document as every candidate saw it. The scoped passage is outlined; blocks a
                candidate rewrote or removed are marked.
              </div>
            </div>
          </div>
          <div class="docws-column-body" ref={baseBodyRef}>
            <DocumentViewer
              blocks={base.blocks()}
              scope={scope()}
              changes={baseMarks()}
              renderKey="base"
              page={base.page()}
            />
          </div>
        </section>
        {seam('base')}
        <Index each={candidates()}>
          {(candidate, i) => (
            <>
              <CandidateColumn
                run={props.run}
                candidate={candidate()}
                baseBlocks={base.blocks()}
                baseSource={baseContent() ?? ''}
                partialCapable={!base.page()}
                revealAgents={revealAgents()}
                showSource={showSource()}
                onBaseChanges={(id, marks) => setBaseChanges((prev) => ({ ...prev, [id]: marks }))}
                style={columnStyle(`candidate-${i}`)}
              />
              {seam(`candidate-${i}`)}
            </>
          )}
        </Index>
      </div>
    </div>
  );
}
