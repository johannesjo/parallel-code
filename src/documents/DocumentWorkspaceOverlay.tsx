import './documents.css';
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import { store } from '../store/core';
import { getProject } from '../store/projects';
import {
  closeDocumentWorkspace,
  documentStore,
  reviewableRuns,
  setDocumentSelection,
  setDocumentView,
  openDocumentCompare,
  type DocumentView,
} from '../store/documents';
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
          <span style={{ 'margin-left': 'auto' }} />
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
          <DocumentViewer
            blocks={blocks.blocks()}
            selectable
            selection={range()}
            onSelect={setDocumentSelection}
            renderKey="main"
          >
            <Show when={selection()}>
              {(s) => (
                <RunComposer
                  selection={s()}
                  anchorTop={anchorTop()}
                  onClose={() => setDocumentSelection(null)}
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
