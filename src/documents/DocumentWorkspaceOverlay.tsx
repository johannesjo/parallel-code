import './documents.css';
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import { store } from '../store/core';
import { getProject } from '../store/projects';
import {
  closeDocumentWorkspace,
  dismissUndo,
  documentStore,
  reviewableRuns,
  setDocumentComposerDraft,
  setDocumentSelection,
  setDocumentView,
  setShowResolvedAnnotations,
  openDocumentCompare,
  undoDeleteDocumentAnnotation,
  type DocumentView,
} from './store';
import { relocateAnchor } from './annotation-anchor';
import type { DocumentAnnotation } from '../ipc/types';
import { AnnotationBubble } from './AnnotationBubble';
import { EditProjectDialog } from '../components/EditProjectDialog';
import type { Project } from '../store/types';
import { CompareView } from './CompareView';
import { DocumentViewer } from './DocumentViewer';
import { HistoryView } from './HistoryView';
import { RunComposer } from './RunComposer';
import { RunsRail } from './RunsRail';
import { createRenderedBlocks } from './use-blocks';

function DocumentIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M4 1.5h5l3 3v10H4z" />
      <path d="M9 1.5v3h3M6 8h4M6 10.5h4" />
    </svg>
  );
}

function DocumentPane() {
  let docRef: HTMLDivElement | undefined;
  const blocks = createRenderedBlocks(() => documentStore.snapshot?.content ?? null);
  const [anchorTop, setAnchorTop] = createSignal(0);
  const selection = () => documentStore.selection;
  const range = createMemo(() => {
    const s = selection();
    return s && !s.wholeDocument ? { start: s.startBlock, end: s.endBlock } : null;
  });

  // Relocate every bubble on the current version; the ones that cannot be
  // placed are shown as detached rather than attached to the wrong passage.
  const placed = createMemo(() => {
    const all = blocks.blocks();
    const byBlock = new Map<number, DocumentAnnotation[]>();
    const detached: DocumentAnnotation[] = [];
    const located = new Map<string, { startBlock: number; endBlock: number }>();
    for (const a of documentStore.annotations) {
      if (a.resolved && !documentStore.showResolved) continue;
      const loc = relocateAnchor(a.anchor, all);
      if (!loc) {
        detached.push(a);
        continue;
      }
      located.set(a.id, loc);
      const list = byBlock.get(loc.endBlock) ?? [];
      list.push(a);
      byBlock.set(loc.endBlock, list);
    }
    return { byBlock, detached, located };
  });
  const openCount = () => documentStore.annotations.filter((a) => !a.resolved).length;
  const resolvedCount = () => documentStore.annotations.filter((a) => a.resolved).length;

  /** A bubble becomes a task: select its passage and open the composer with its text. */
  function makeTask(annotation: DocumentAnnotation) {
    const all = blocks.blocks();
    const loc = placed().located.get(annotation.id) ?? relocateAnchor(annotation.anchor, all);
    if (!loc) return;
    const text = annotation.answer
      ? `${annotation.text}\n\nEarlier answer from ${annotation.answer.agentName}:\n${annotation.answer.text}`
      : annotation.text;
    setDocumentComposerDraft({ text, annotationId: annotation.id });
    setDocumentSelection({
      startBlock: loc.startBlock,
      endBlock: loc.endBlock,
      startLine: all[loc.startBlock].startLine,
      endLine: all[loc.endBlock].endLine,
      quote: all
        .slice(loc.startBlock, loc.endBlock + 1)
        .map((b) => b.raw.replace(/\n+$/, ''))
        .join('\n\n'),
      heading: annotation.anchor.heading,
      wholeDocument: false,
    });
  }

  // The undo offer expires on its own.
  createEffect(
    on(
      () => documentStore.lastDeleted,
      (deleted) => {
        if (!deleted) return;
        const timer = setTimeout(() => dismissUndo(), 10_000);
        onCleanup(() => clearTimeout(timer));
      },
    ),
  );

  // Park the composer right under the last selected block.
  createEffect(
    on([selection, blocks.blocks], () => {
      const s = selection();
      if (!s || !docRef) return;
      requestAnimationFrame(() => {
        if (!docRef) return;
        const index = s.wholeDocument ? 0 : s.endBlock;
        const el = docRef.querySelector<HTMLElement>(`.doc-block[data-block-index="${index}"]`);
        const top = s.wholeDocument ? 0 : el ? el.offsetTop + el.offsetHeight + 8 : 0;
        setAnchorTop(top);
        if (!s.wholeDocument && el) {
          const composer = docRef.querySelector<HTMLElement>('.docws-composer');
          composer?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      });
    }),
  );

  const toolbarLabel = () => {
    const s = selection();
    if (!s) return 'Select text, click a block, or use § on a heading to scope a task';
    return s.wholeDocument
      ? 'Whole document selected'
      : `Selected lines ${s.startLine}–${s.endLine}`;
  };

  function selectWholeDocument() {
    const all = blocks.blocks();
    if (all.length === 0) return;
    setDocumentSelection({
      startBlock: 0,
      endBlock: all.length - 1,
      startLine: all[0].startLine,
      endLine: all[all.length - 1].endLine,
      quote: '',
      heading: undefined,
      wholeDocument: true,
    });
  }

  return (
    <>
      <div class="docws-main">
        <div class="docws-toolbar">
          <span>{toolbarLabel()}</span>
          <Show when={documentStore.lastDeleted}>
            <span class="docws-undo">
              Deleted a {documentStore.lastDeleted?.kind}.
              <button
                type="button"
                class="docws-btn docws-btn-sm"
                onClick={() => void undoDeleteDocumentAnnotation()}
              >
                Undo
              </button>
            </span>
          </Show>
          <span style={{ 'margin-left': 'auto' }} />
          <Show when={openCount() + resolvedCount() > 0}>
            <label class="docws-toggle" title="Resolved bubbles collapse to one line">
              <input
                type="checkbox"
                checked={documentStore.showResolved}
                onChange={(e) => setShowResolvedAnnotations(e.currentTarget.checked)}
              />
              {resolvedCount()} resolved
            </label>
          </Show>
          <button type="button" class="docws-btn docws-btn-sm" onClick={selectWholeDocument}>
            Whole document
          </button>
          <Show when={selection()}>
            <button
              type="button"
              class="docws-btn docws-btn-sm"
              onClick={() => setDocumentSelection(null)}
            >
              Clear
            </button>
          </Show>
        </div>
        <Show when={documentStore.snapshot?.missing}>
          <div class="docws-older-banner">The document file is missing from the checkout.</div>
        </Show>
        <div class="docws-doc" ref={docRef}>
          <Show when={placed().detached.length > 0}>
            <div class="docws-detached-section">
              <div class="docws-rail-title">Detached notes</div>
              <div class="docws-empty" style={{ padding: '2px 0 6px' }}>
                Their passages are no longer in the document. Resolve or delete them, or turn them
                into a task on a new selection.
              </div>
              <For each={placed().detached}>
                {(a) => <AnnotationBubble annotation={a} detached onMakeTask={makeTask} />}
              </For>
            </div>
          </Show>
          <DocumentViewer
            blocks={blocks.blocks()}
            selectable
            selection={range()}
            onSelect={setDocumentSelection}
            renderKey="main"
            afterBlock={(index) => (
              <For each={placed().byBlock.get(index) ?? []}>
                {(a) => <AnnotationBubble annotation={a} onMakeTask={makeTask} />}
              </For>
            )}
          >
            <Show when={selection()}>
              {(s) => (
                <RunComposer
                  selection={s()}
                  blocks={blocks.blocks()}
                  anchorTop={anchorTop()}
                  onClose={() => {
                    setDocumentSelection(null);
                    setDocumentComposerDraft(null);
                  }}
                />
              )}
            </Show>
          </DocumentViewer>
          <Show
            when={
              blocks.blocks().length === 0 &&
              !blocks.rendering() &&
              documentStore.snapshot &&
              !documentStore.snapshot.missing
            }
          >
            <div class="docws-empty">The document is empty.</div>
          </Show>
        </div>
      </div>
      <RunsRail />
    </>
  );
}

/** Full-window surface for a document project: document, compare, history. */
export function DocumentWorkspaceOverlay() {
  const project = createMemo<Project | undefined>(() =>
    store.activeDocumentProjectId ? getProject(store.activeDocumentProjectId) : undefined,
  );
  const [editing, setEditing] = createSignal<Project | null>(null);
  const snapshot = () => documentStore.snapshot;
  const compareRun = () =>
    documentStore.compareRunId ? documentStore.runs[documentStore.compareRunId] : undefined;
  const reviewable = createMemo(() => reviewableRuns());

  // Close when the project disappears (removed while open).
  createEffect(() => {
    if (store.activeDocumentProjectId && !project()) closeDocumentWorkspace();
  });

  onCleanup(() => {
    if (documentStore.projectId) closeDocumentWorkspace();
  });

  function tab(view: DocumentView, label: string, count?: number) {
    return (
      <button
        type="button"
        class="docws-tab"
        role="tab"
        aria-selected={documentStore.view === view}
        onClick={() => {
          if (view === 'compare' && !compareRun() && reviewable()[0])
            openDocumentCompare(reviewable()[0].id);
          else setDocumentView(view);
        }}
      >
        {label}
        <Show when={count}>
          <span class="docws-count">{count}</span>
        </Show>
      </button>
    );
  }

  return (
    <div class="docws-overlay" role="dialog" aria-label="Document workspace">
      <div class="docws-header">
        <div class="docws-title">
          <DocumentIcon />
          <span>{project()?.name}</span>
        </div>
        <span class="docws-subtitle" title={project()?.documentPath}>
          {project()?.documentPath}
        </span>
        <div class="docws-tabs" role="tablist">
          {tab('document', 'Document')}
          {tab('compare', 'Compare', reviewable().length)}
          {tab('history', 'History')}
        </div>
        <button type="button" class="docws-btn" onClick={() => setEditing(project() ?? null)}>
          Project
        </button>
        <button type="button" class="docws-btn" onClick={() => closeDocumentWorkspace()}>
          Close
        </button>
      </div>
      <div class="docws-status-line">
        <span>{snapshot()?.branch ?? 'detached'}</span>
        <span>@ {snapshot()?.headSha?.slice(0, 7) ?? 'no commits'}</span>
        <Show when={snapshot()?.dirty}>
          <span class="docws-dirty">uncommitted edits (committed on the next run)</span>
        </Show>
        <Show when={documentStore.error}>
          <span class="docws-error">{documentStore.error}</span>
        </Show>
        <Show when={documentStore.loading}>
          <span>loading…</span>
        </Show>
      </div>
      <div class="docws-body">
        <Show when={documentStore.view === 'document'}>
          <DocumentPane />
        </Show>
        <Show when={documentStore.view === 'compare'}>
          <div class="docws-main" style={{ overflow: 'hidden' }}>
            <Show when={reviewable().length > 1 && compareRun()}>
              <div class="docws-compare-bar">
                <span>Run</span>
                <select
                  class="docws-select"
                  value={compareRun()?.id}
                  onChange={(e) => openDocumentCompare(e.currentTarget.value)}
                >
                  <For each={reviewable()}>
                    {(r) => <option value={r.id}>{r.instruction.slice(0, 80)}</option>}
                  </For>
                </select>
              </div>
            </Show>
            <Show
              when={documentStore.compareRunId && compareRun() ? documentStore.compareRunId : null}
              keyed
              fallback={
                <div class="docws-empty" style={{ padding: '24px' }}>
                  Nothing to compare yet. Finished runs with proposals appear here.
                </div>
              }
            >
              {(runId) => <CompareView run={documentStore.runs[runId]} />}
            </Show>
          </div>
        </Show>
        <Show when={documentStore.view === 'history'}>
          <div class="docws-main" style={{ overflow: 'hidden' }}>
            <HistoryView />
          </div>
        </Show>
      </div>
      <EditProjectDialog project={editing()} onClose={() => setEditing(null)} />
    </div>
  );
}
