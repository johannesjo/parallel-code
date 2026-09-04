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
import { isHtmlDocument } from './html-document';
import type { DocumentAnnotation } from './types';
import { AnnotationBubble } from './AnnotationBubble';
import { EditProjectDialog } from '../components/EditProjectDialog';
import type { Project } from '../store/types';
import { CompareView } from './CompareView';
import { DocumentViewer } from './DocumentViewer';
import { HistoryView } from './HistoryView';
import { RunComposer } from './RunComposer';
import { RunsRail } from './RunsRail';
import { createRenderedBlocks } from './use-blocks';
import { DocumentIcon } from './DocumentIcon';
import { openInEditor } from '../lib/shell';
import { errMessage } from '../lib/log';
import { showNotification } from '../store/notification';

function DocumentPane() {
  let docRef: HTMLDivElement | undefined;
  const blocks = createRenderedBlocks(() => documentStore.snapshot?.content ?? null);
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

  // One composer instance, moved under whichever block ends the selection (or
  // above the document for a whole-document task), so the typed instruction
  // and agent picks survive a change of passage. It sits in the flow: the
  // prose after it moves down instead of disappearing behind it.
  const composerHost = (
    <div class="docws-composer-host">
      <Show when={selection()}>
        {(s) => (
          <RunComposer
            selection={s()}
            blocks={blocks.blocks()}
            onClose={() => {
              setDocumentSelection(null);
              setDocumentComposerDraft(null);
            }}
          />
        )}
      </Show>
    </div>
  ) as HTMLDivElement;
  const composerAfterBlock = () => {
    const s = selection();
    return s && !s.wholeDocument ? s.endBlock : -1;
  };
  const claimComposer = (slot: HTMLDivElement) => slot.appendChild(composerHost);

  // Bring the composer into view when it opens under a new passage. The store
  // merges a new selection into the old object, so track the range itself.
  const selectedRange = () => {
    const s = selection();
    return s ? `${s.startBlock}-${s.endBlock}-${s.wholeDocument ? 'all' : ''}` : null;
  };
  createEffect(
    on([selectedRange, blocks.blocks], () => {
      if (!selection()) return;
      requestAnimationFrame(() => {
        docRef
          ?.querySelector<HTMLElement>('.docws-composer')
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        // Moving the composer between slots blurred it, and the passage was
        // picked to write about.
        composerHost.querySelector('textarea')?.focus({ preventScroll: true });
      });
    }),
  );

  // A whole HTML page cannot survive the markdown path: marked splits it at
  // blank lines and the sanitizer drops <style>, so it renders as debris. Show
  // it as the page it is, and keep the block view one click away for scoping.
  const isHtml = createMemo(() => isHtmlDocument(documentStore.snapshot?.content));
  const [htmlView, setHtmlView] = createSignal<'preview' | 'blocks'>('preview');
  const showsPreview = () => isHtml() && htmlView() === 'preview';

  const toolbarLabel = () => {
    if (showsPreview()) return 'Preview of the HTML document — switch to Blocks to scope a task';
    const s = selection();
    if (!s) return 'Select text, click a block, or use § on a heading to scope a task';
    if (s.wholeDocument) return 'Whole document selected';
    return s.startLine === s.endLine
      ? `Selected line ${s.startLine}`
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
          <Show when={isHtml()}>
            <span class="docws-tabs">
              <button
                type="button"
                class="docws-tab"
                aria-selected={htmlView() === 'preview'}
                onClick={() => setHtmlView('preview')}
              >
                Preview
              </button>
              <button
                type="button"
                class="docws-tab"
                aria-selected={htmlView() === 'blocks'}
                onClick={() => setHtmlView('blocks')}
              >
                Blocks
              </button>
            </span>
          </Show>
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
          <Show when={resolvedCount() > 0}>
            <label class="docws-toggle" title="Resolved bubbles collapse to one line">
              <input
                type="checkbox"
                checked={documentStore.showResolved}
                onChange={(e) => setShowResolvedAnnotations(e.currentTarget.checked)}
              />
              {resolvedCount()} resolved
            </label>
          </Show>
          <Show when={!showsPreview()}>
            <button type="button" class="docws-btn docws-btn-sm" onClick={selectWholeDocument}>
              Whole document
            </button>
          </Show>
          <Show when={selection() && !showsPreview()}>
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
        <Show when={showsPreview()}>
          {/* Fully sandboxed: the page renders with its own CSS but gets no
              scripts, no forms and no same-origin access to the app. */}
          <iframe
            class="docws-html-preview"
            sandbox=""
            srcdoc={documentStore.snapshot?.content ?? ''}
            title="HTML document preview"
          />
        </Show>
        <div class="docws-doc" ref={docRef} classList={{ 'is-hidden': showsPreview() }}>
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
          <Show when={selection()?.wholeDocument}>
            <div class="docws-composer-slot" ref={claimComposer} />
          </Show>
          <DocumentViewer
            blocks={blocks.blocks()}
            selectable
            selection={range()}
            onSelect={setDocumentSelection}
            renderKey="main"
            afterBlock={(index) => (
              <>
                <For each={placed().byBlock.get(index) ?? []}>
                  {(a) => <AnnotationBubble annotation={a} onMakeTask={makeTask} />}
                </For>
                <Show when={composerAfterBlock() === index}>
                  <div class="docws-composer-slot" ref={claimComposer} />
                </Show>
              </>
            )}
          />
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
  const editorCommand = () => store.editorCommand.trim();
  const editorButtonLabel = () => {
    const documentPath = project()?.documentPath ?? 'document';
    return editorCommand()
      ? `Open ${documentPath} in ${editorCommand()}`
      : `Configure an editor command in Settings to open ${documentPath}`;
  };

  // Close when the project disappears (removed while open).
  createEffect(() => {
    if (store.activeDocumentProjectId && !project()) closeDocumentWorkspace();
  });

  onCleanup(() => {
    if (documentStore.projectId) closeDocumentWorkspace();
  });

  function openDocumentInEditor() {
    const currentProject = project();
    const command = editorCommand();
    if (!currentProject?.documentPath || !command) return;
    const documentPath = `${currentProject.path.replace(/\/$/, '')}/${currentProject.documentPath}`;
    openInEditor(command, documentPath).catch((err) =>
      showNotification(`Editor failed: ${errMessage(err)}`),
    );
  }

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
      <div class="docws-header" data-tauri-drag-region>
        <div class="docws-title">
          <DocumentIcon />
          <span>{project()?.name}</span>
          <button
            type="button"
            class="docws-btn docws-open-editor"
            aria-label={editorButtonLabel()}
            title={editorButtonLabel()}
            disabled={!editorCommand() || !project()?.documentPath}
            onClick={() => void openDocumentInEditor()}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.5 2a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3a.75.75 0 0 1 1.5 0v3A3 3 0 0 1 12.5 16h-9A3 3 0 0 1 0 12.5v-9A3 3 0 0 1 3.5 0h3a.75.75 0 0 1 0 1.5h-3ZM10 .75a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V2.56L8.53 8.53a.75.75 0 0 1-1.06-1.06L13.44 1.5H10.75A.75.75 0 0 1 10 .75Z" />
            </svg>
          </button>
        </div>
        <span class="docws-subtitle" title={project()?.documentPath}>
          {project()?.documentPath}
        </span>
        <span class="docws-head-chip" title="Checked-out branch and head commit">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
          </svg>
          {snapshot()?.branch ?? 'detached'} · {snapshot()?.headSha?.slice(0, 7) ?? 'no commits'}
        </span>
        <Show when={snapshot()?.dirty}>
          <span
            class="docws-head-chip is-warning"
            title="Committed as “Manual edits” before the next run"
          >
            uncommitted edits
          </span>
        </Show>
        <Show when={documentStore.loading}>
          <span class="docws-head-chip">loading…</span>
        </Show>
        <div class="docws-tabs" role="tablist">
          {tab('document', 'Document')}
          {tab('compare', 'Compare', reviewable().length)}
          {tab('history', 'History')}
        </div>
        <button type="button" class="docws-btn" onClick={() => setEditing(project() ?? null)}>
          Project
        </button>
        <button
          type="button"
          class="docws-btn"
          title="Close (Esc)"
          onClick={() => closeDocumentWorkspace()}
        >
          Close
        </button>
      </div>
      <Show when={documentStore.error}>
        <div class="docws-banner docws-banner-error" role="alert">
          {documentStore.error}
        </div>
      </Show>
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
                <div class="docws-empty-state">
                  <div class="docws-empty-state-title">Nothing to compare yet</div>
                  <div>
                    Select a passage on the Document tab and run a task. Finished runs with
                    proposals appear here.
                  </div>
                  <button
                    type="button"
                    class="docws-btn"
                    onClick={() => setDocumentView('document')}
                  >
                    Go to the document
                  </button>
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
