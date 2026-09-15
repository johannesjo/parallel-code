import './documents.css';
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from 'solid-js';
import { store } from '../store/core';
import { getProject, updateProject } from '../store/projects';
import {
  activeDocumentPath,
  closeDocumentWorkspace,
  commitDocumentEdits,
  discardDocumentEdits,
  dismissUndo,
  documentStore,
  goBackDocument,
  openDocumentFile,
  previousDocumentPath,
  refreshDocumentSnapshot,
  reviewableRuns,
  setDocumentComposerDraft,
  setDocumentSelection,
  setDocumentView,
  setShowResolvedAnnotations,
  openDocumentCompare,
  undoDeleteDocumentAnnotation,
  type DocumentView,
} from './store';
import { resetWorkspaceUi, setRailTab, workspaceUi } from './workspace-ui';
import {
  activateDocumentAgentTask,
  ensureDocumentAgentTask,
  releaseDocumentAgentTask,
} from './agent-task';
import { documentAgentTaskId } from './task-id';
import { setActiveTask } from '../store/navigation';
import { getTaskFocusedPanel, triggerFocus } from '../store/focused-panel';
import { findAnchorTarget } from './links';
import { relocateAnchor } from './annotation-anchor';
import { isHtmlDocument } from './html-document';
import type { DocumentAnnotation } from './types';
import type { DocumentBlock } from './markdown-blocks';
import { AnnotationBubble } from './AnnotationBubble';
import { AnnotationMarker } from './AnnotationMarker';
import { EditProjectDialog } from '../components/EditProjectDialog';
import type { Project } from '../store/types';
import { CompareDialog } from './CompareDialog';
import { DocumentViewer, releasesSelection, selectionFromRange } from './DocumentViewer';
import { HistoryView } from './HistoryView';
import { RunComposer } from './RunComposer';
import { RightPanel } from './RightPanel';
import { CandidateOutputDialog } from './CandidateOutputDialog';
import { BlockEditor, type BlockEditTarget } from './BlockEditor';
import { MarkdownEditor } from './MarkdownEditor';
import { afterSavingMarkdown, readMarkdownDraft } from './markdown-editing';
import { ResizablePanel, type PanelChild } from '../components/ResizablePanel';
import { createRenderedBlocks } from './use-blocks';
import {
  ChevronDownThinIcon,
  DocumentIcon,
  EnterFocusIcon,
  ExitFocusIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  FullWidthIcon,
  GearIcon,
  GitBranchAltIcon,
} from '../components/icons';
import { ActionIcon } from './BlockActions';
import { Dialog } from '../components/Dialog';
import { openInEditor, revealItemInDir } from '../lib/shell';
import { CloseIcon } from '../components/icons';
import { setDocumentFullWidth, toggleTaskFocusMode } from '../store/ui';
import { isTerminalPaneOnScreen } from '../lib/terminalPaneVisibility';
import { errMessage } from '../lib/log';
import { showNotification } from '../store/notification';

/** Space between the picked passage and the composer, and from the column's edges. */
const COMPOSER_GAP = 8;

function DocumentPane(props: { project: Project }) {
  // Floating controls live under document.body, outside the tile's visibility/inert boundary.
  const floatingUiVisible = () => {
    const taskId = documentAgentTaskId(props.project.id);
    return isTerminalPaneOnScreen({
      taskId,
      activeTaskId: store.activeTaskId,
      focusMode: store.focusMode && !store.showNewTaskPanel,
      viewportVisibility: store.taskViewportVisibility[taskId],
    });
  };
  const zoom = () => {
    const value = props.project.documentZoom;
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0.5, Math.min(2, value))
      : 1;
  };
  function setZoom(value: number) {
    updateProject(props.project.id, {
      documentZoom: Math.max(0.5, Math.min(2, Math.round(value * 10) / 10)),
    });
  }
  let docRef: HTMLDivElement | undefined;
  let mainRef: HTMLDivElement | undefined;
  let scrollRef: HTMLDivElement | undefined;
  let layerRef: HTMLDivElement | undefined;
  let reviseRef: HTMLButtonElement | undefined;
  // Where the composer sits when a passage is picked; null puts it at the foot.
  const [anchorTop, setAnchorTop] = createSignal<number | null>(null);
  const [composerSpace, setComposerSpace] = createSignal(560);
  // The prose scrolls in `scrollRef`; the reading position is held there
  // across a re-render, so an edit landing in the file leaves it alone.
  const blocks = createRenderedBlocks(
    () => documentStore.snapshot?.content ?? null,
    () => scrollRef,
  );
  const documentPath = () => activeDocumentPath() ?? props.project.documentPath ?? '';
  const selection = () => documentStore.selection;
  const [blockEdit, setBlockEdit] = createSignal<BlockEditTarget | null>(null);
  const editableBlock = () => {
    const s = selection();
    if (!s || s.wholeDocument || s.startBlock !== s.endBlock || blocks.rendering()) return null;
    const block = blocks.blocks()[s.startBlock];
    return block?.startOffset !== undefined && block.endOffset !== undefined ? block : null;
  };
  const range = createMemo(() => {
    const s = selection();
    return s && !s.wholeDocument ? { start: s.startBlock, end: s.endBlock } : null;
  });
  // The composer is up while there is something for it to do: a picked
  // passage, or a task asked for on the whole document.
  const composerOpen = () => !!selection() || !!documentStore.composerDraft;

  /** Open the source editor on a block; only blocks that map back to the source qualify. */
  function editBlock(block: DocumentBlock | null) {
    const source = documentStore.snapshot?.content;
    // Mid-render the blocks belong to an older read of the file than the source.
    if (!block || source === undefined || blocks.rendering()) return;
    if (block.startOffset === undefined || block.endOffset === undefined) return;
    setBlockEdit({ projectRoot: props.project.path, documentPath: documentPath(), source, block });
  }

  // Relocate every bubble on the current version; the ones that cannot be
  // placed are shown as detached rather than attached to the wrong passage.
  const placed = createMemo(() => {
    const all = blocks.blocks();
    const byBlock = new Map<number, DocumentAnnotation[]>();
    const detached: DocumentAnnotation[] = [];
    const located = new Map<string, { startBlock: number; endBlock: number }>();
    for (const a of documentStore.annotations) {
      // Bubbles belong to one document each; the others' stay out of this one.
      if (a.anchor.path !== documentPath()) continue;
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
  const resolvedCount = () =>
    documentStore.annotations.filter((a) => a.resolved && a.anchor.path === documentPath()).length;

  /** A link to another file of the project: open it, then land on its anchor. */
  async function navigate(path: string, anchor?: string) {
    await openDocumentFile(path);
    if (!anchor) return;
    // The blocks render after the snapshot arrives; give them a frame.
    requestAnimationFrame(() => {
      if (docRef) findAnchorTarget(docRef, anchor)?.scrollIntoView({ block: 'start' });
    });
  }

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

  function blockElement(index: number): HTMLElement | null {
    return docRef?.querySelector<HTMLElement>(`[data-block-index="${index}"]`) ?? null;
  }

  /**
   * Puts the composer right under the picked passage, above it when the foot
   * of the column is too close, and keeps it inside the column while the
   * prose scrolls under it. With nothing picked it rests at the foot.
   */
  function placeComposer() {
    if (!mainRef || !layerRef) return;
    const column = mainRef.getBoundingClientRect();
    const minTop = (scrollRef?.getBoundingClientRect().top ?? column.top) - column.top;
    setComposerSpace(Math.max(0, column.height - minTop - 2 * COMPOSER_GAP));
    const s = selection();
    const last = s && !s.wholeDocument ? blockElement(s.endBlock) : null;
    const first = s && !s.wholeDocument ? blockElement(s.startBlock) : null;
    if (!last || !first) {
      setAnchorTop(null);
      return;
    }
    const height = layerRef.offsetHeight;
    const maxTop = column.height - height - COMPOSER_GAP;
    const below = last.getBoundingClientRect().bottom - column.top + COMPOSER_GAP;
    const above = first.getBoundingClientRect().top - column.top - height - COMPOSER_GAP;
    const top = below <= maxTop ? below : above >= minTop ? above : maxTop;
    setAnchorTop(Math.max(minTop + COMPOSER_GAP, Math.min(top, maxTop)));
  }

  // Bring the picked passage into view and hang the composer off it. The store
  // merges a new selection into the old object, so track the range itself.
  const selectedRange = () => {
    const s = selection();
    return s ? `${s.startBlock}-${s.endBlock}-${s.wholeDocument ? 'all' : ''}` : null;
  };
  createEffect(
    on([selectedRange, blocks.blocks], () => {
      const s = selection();
      requestAnimationFrame(() => {
        if (s && !s.wholeDocument)
          blockElement(s.endBlock)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        placeComposer();
      });
    }),
  );

  // The composer follows the passage as the prose scrolls, as its own height
  // changes with the mode and the agents picked, and as the prose reflows
  // under it (a theme or width change moves the passage without a scroll).
  // The layer is created with the first snapshot, well after this mounts, so
  // both are observed from their own refs rather than here.
  const reflow = new ResizeObserver(() => placeComposer());
  onCleanup(() => reflow.disconnect());
  onMount(() => {
    if (mainRef) reflow.observe(mainRef);
    if (scrollRef) reflow.observe(scrollRef);
    scrollRef?.addEventListener('scroll', placeComposer, { passive: true });
    window.addEventListener('resize', placeComposer);
    onCleanup(() => {
      scrollRef?.removeEventListener('scroll', placeComposer);
      window.removeEventListener('resize', placeComposer);
    });
  });

  // A whole HTML page renders inline as element blocks in its own style, so it
  // is worked on like any document. The sandboxed page render stays one click
  // away for pages that lean on scripts or external stylesheets.
  const isHtml = createMemo(() => isHtmlDocument(documentStore.snapshot?.content));
  const [htmlView, setHtmlView] = createSignal<'inline' | 'page'>('inline');
  const showsPreview = () => isHtml() && htmlView() === 'page';
  const canEditMarkdown = () => /\.(md|markdown)$/i.test(documentPath()) && !isHtml();
  const [markdownView, setMarkdownView] = createSignal<'preview' | 'edit'>('preview');
  const [editorOpened, setEditorOpened] = createSignal(false);
  const editingMarkdown = () => canEditMarkdown() && markdownView() === 'edit';
  // File identity, rather than the changing snapshot, owns the editor and its undo history.
  const editorKey = createMemo(() => JSON.stringify([props.project.path, documentPath()]));
  createEffect(
    on(editorKey, () => {
      const hasDraft = !!readMarkdownDraft(props.project.path, documentPath());
      setEditorOpened(hasDraft);
      setMarkdownView(hasDraft ? 'edit' : 'preview');
    }),
  );

  function startEditing() {
    setDocumentSelection(null);
    setDocumentComposerDraft(null);
    setEditorOpened(true);
    setMarkdownView('edit');
    requestAnimationFrame(() => mainRef?.querySelector<HTMLElement>('.cm-content')?.focus());
  }

  const toolbarLabel = () => {
    if (editingMarkdown()) return 'Edit Markdown directly · autosaves when you pause';
    if (showsPreview()) return 'Sandboxed render of the page — switch to Inline to scope a task';
    const s = selection();
    if (!s || s.wholeDocument)
      return 'Click a block, drag across blocks, or use § on a heading to work on a passage';
    return s.startLine === s.endLine
      ? `Selected line ${s.startLine}`
      : `Selected lines ${s.startLine}–${s.endLine}`;
  };

  return (
    <div class="docws-main docws-doc-main" ref={mainRef}>
      <div class="docws-toolbar">
        <Show when={canEditMarkdown() && documentStore.snapshot && !documentStore.snapshot.missing}>
          <div class="docws-tabs" role="group" aria-label="Markdown view">
            <button
              type="button"
              class="docws-tab"
              aria-pressed={markdownView() === 'preview'}
              onClick={() => afterSavingMarkdown(() => setMarkdownView('preview'))}
            >
              Preview
            </button>
            <button
              type="button"
              class="docws-tab"
              aria-pressed={markdownView() === 'edit'}
              onClick={startEditing}
            >
              Edit
            </button>
          </div>
        </Show>
        <Show when={isHtml()}>
          <span class="docws-tabs">
            <button
              type="button"
              class="docws-tab"
              aria-selected={htmlView() === 'inline'}
              title="The page as blocks you can select and scope tasks to"
              onClick={() => setHtmlView('inline')}
            >
              Inline
            </button>
            <button
              type="button"
              class="docws-tab"
              aria-selected={htmlView() === 'page'}
              title="The page in a sandboxed frame, exactly as a browser shows it"
              onClick={() => setHtmlView('page')}
            >
              Page
            </button>
          </span>
        </Show>
        <Show when={!showsPreview() && !composerOpen() && !editingMarkdown()}>
          <button
            type="button"
            ref={reviseRef}
            class="docws-btn docws-btn-sm docws-toolbar-task"
            title="Open the composer on the whole document"
            onClick={() => setDocumentComposerDraft({ text: '', mode: 'proposals' })}
          >
            <ActionIcon kind="proposals" />
            Revise document
          </button>
        </Show>
        <span class="docws-toolbar-label" title={toolbarLabel()}>
          {toolbarLabel()}
        </span>
        <Show when={editableBlock() && !showsPreview() && !editingMarkdown()}>
          <button
            type="button"
            class="docws-btn docws-btn-sm"
            onClick={() => editBlock(editableBlock())}
          >
            Edit block
          </button>
        </Show>
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
        <span class="docws-toolbar-spacer" />
        <div class="docws-zoom" role="group" aria-label="Document zoom">
          <button
            type="button"
            class="docws-btn docws-btn-sm"
            aria-label="Zoom out document"
            title="Zoom out document"
            disabled={zoom() <= 0.5}
            onClick={() => setZoom(zoom() - 0.1)}
          >
            −
          </button>
          <button
            type="button"
            class="docws-btn docws-btn-sm"
            aria-label="Reset document zoom"
            title="Reset document zoom"
            onClick={() => setZoom(1)}
          >
            {Math.round(zoom() * 100)}%
          </button>
          <button
            type="button"
            class="docws-btn docws-btn-sm"
            aria-label="Zoom in document"
            title="Zoom in document"
            disabled={zoom() >= 2}
            onClick={() => setZoom(zoom() + 0.1)}
          >
            +
          </button>
        </div>
        <Show when={!showsPreview()}>
          <button
            type="button"
            class="docws-btn docws-btn-sm docws-width-toggle"
            aria-label="Full width"
            aria-pressed={store.documentFullWidth}
            title={
              store.documentFullWidth
                ? 'Back to a reading width'
                : 'Let the document take the whole column'
            }
            onClick={() => setDocumentFullWidth(!store.documentFullWidth)}
          >
            <FullWidthIcon size={14} />
            <span class="docws-width-label">Full width</span>
          </button>
        </Show>
        <Show when={resolvedCount() > 0 && !editingMarkdown()}>
          <label class="docws-toggle" title="Resolved bubbles collapse to one line">
            <input
              type="checkbox"
              checked={documentStore.showResolved}
              onChange={(e) => setShowResolvedAnnotations(e.currentTarget.checked)}
            />
            {resolvedCount()} resolved
          </label>
        </Show>
      </div>
      <Show when={documentStore.snapshot?.missing}>
        <div class="docws-older-banner">The document file is missing from the checkout.</div>
      </Show>
      <Show when={canEditMarkdown() && editorOpened() && documentStore.snapshot}>
        <Show keyed when={editorKey()}>
          {(_key) => (
            <div
              class="docws-editor-pane"
              classList={{
                'is-hidden': !editingMarkdown(),
                'is-full-width': store.documentFullWidth,
              }}
              style={{ zoom: zoom() }}
            >
              <MarkdownEditor
                projectRoot={props.project.path}
                documentPath={documentPath()}
                source={documentStore.snapshot?.content ?? ''}
                missing={documentStore.snapshot?.missing ?? false}
                onSaved={refreshDocumentSnapshot}
              />
            </div>
          )}
        </Show>
      </Show>
      <Show when={showsPreview()}>
        {/* Fully sandboxed: the page renders with its own CSS but gets no
              scripts, no forms and no same-origin access to the app. */}
        <div class="docws-html-viewport">
          <iframe
            class="docws-html-preview"
            style={{
              width: `${100 / zoom()}%`,
              height: `${100 / zoom()}%`,
              transform: `scale(${zoom()})`,
            }}
            sandbox=""
            srcdoc={documentStore.snapshot?.content ?? ''}
            title="HTML document preview"
          />
        </div>
      </Show>
      {/* Kept mounted while previewing so blocks, annotations and scroll
            position survive the toggle. */}
      <div
        class="docws-scroll"
        ref={scrollRef}
        classList={{ 'is-hidden': showsPreview() || editingMarkdown() }}
        onMouseUp={(e) => {
          if (releasesSelection(e.target)) setDocumentSelection(null);
        }}
      >
        <div
          class="docws-doc"
          style={{ zoom: zoom() }}
          ref={(el) => {
            docRef = el;
            reflow.observe(el);
          }}
          classList={{ 'is-page': isHtml(), 'is-full-width': store.documentFullWidth }}
        >
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
            floatingUiVisible={floatingUiVisible()}
            selectable
            selection={range()}
            onSelect={setDocumentSelection}
            renderKey="main"
            page={blocks.page()}
            documentPath={documentPath()}
            onNavigate={(path, anchor) => void navigate(path, anchor)}
            onAction={(action, index) => {
              if (action === 'edit') {
                editBlock(blocks.blocks()[index] ?? null);
                return;
              }
              batch(() => {
                setDocumentSelection(
                  selectionFromRange(blocks.blocks(), { start: index, end: index }),
                );
                setDocumentComposerDraft({ text: '', mode: action });
              });
            }}
            hasMarker={(index) => (placed().byBlock.get(index)?.length ?? 0) > 0}
            blockMarker={(index) => {
              const annotations = placed().byBlock.get(index);
              return (
                <Show when={annotations?.length}>
                  <AnnotationMarker
                    annotations={annotations ?? []}
                    onMakeTask={makeTask}
                    floatingUiVisible={floatingUiVisible()}
                  />
                </Show>
              );
            }}
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
      {/* The composer floats over the prose instead of opening inside it, so
          the passage it is about stays where it was picked: right above the
          popover. It is only up while it has work to do: a task on the whole
          document rests at the foot of the column. */}
      <Show
        when={
          documentStore.snapshot &&
          !documentStore.snapshot.missing &&
          composerOpen() &&
          !editingMarkdown()
        }
      >
        <div
          class="docws-composer-layer"
          ref={(el) => {
            layerRef = el;
            reflow.observe(el);
            onCleanup(() => {
              reflow.unobserve(el);
              if (layerRef === el) layerRef = undefined;
            });
          }}
          classList={{ 'is-hidden': showsPreview(), 'is-anchored': anchorTop() !== null }}
          style={{
            '--docws-composer-space': `${composerSpace()}px`,
            ...(anchorTop() !== null ? { top: `${anchorTop()}px`, bottom: 'auto' } : {}),
          }}
        >
          <RunComposer
            selection={selection()}
            blocks={blocks.blocks()}
            onClose={() => {
              setDocumentSelection(null);
              setDocumentComposerDraft(null);
              // The composer takes the focused textarea with it; the toolbar
              // button that reopens it is the nearest place for focus to land.
              requestAnimationFrame(() => reviseRef?.focus({ preventScroll: true }));
            }}
          />
        </div>
      </Show>
      <Show keyed when={blockEdit()}>
        {(target) => (
          <BlockEditor
            target={target}
            onClose={() => setBlockEdit(null)}
            onSaved={() => {
              setDocumentSelection(null);
              void refreshDocumentSnapshot();
            }}
          />
        )}
      </Show>
    </div>
  );
}

/** Document task surface in the main workspace, with its agent below the document. */
export function DocumentWorkspacePanel() {
  const project = createMemo<Project | undefined>(() =>
    store.activeDocumentProjectId ? getProject(store.activeDocumentProjectId) : undefined,
  );
  const taskId = () => {
    const p = project();
    return p ? documentAgentTaskId(p.id) : null;
  };
  const isActive = () => !!taskId() && store.activeTaskId === taskId();
  let preserveInteractionFocus = false;
  function activate() {
    const id = taskId();
    if (id && !isActive()) {
      preserveInteractionFocus = true;
      setActiveTask(id);
    }
  }
  let panelRef!: HTMLDivElement;
  const [wide, setWide] = createSignal(false);
  createEffect(
    on(
      () => (isActive() ? taskId() : null),
      (activeId) => {
        if (!activeId) {
          preserveInteractionFocus = false;
          return;
        }
        // Mouse/focus events already have a target; task shortcuts only change selection.
        if (preserveInteractionFocus) {
          preserveInteractionFocus = false;
          return;
        }
        const frame = requestAnimationFrame(() => {
          const id = taskId();
          if (!id || !isActive() || panelRef.contains(document.activeElement)) return;
          if (workspaceUi.railTab === 'agent') triggerFocus(`${id}:${getTaskFocusedPanel(id)}`);
          if (!panelRef.contains(document.activeElement)) panelRef.focus({ preventScroll: true });
        });
        onCleanup(() => cancelAnimationFrame(frame));
      },
    ),
  );
  onMount(() => {
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 800));
    observer.observe(panelRef);
    setWide(panelRef.clientWidth >= 800);
    onCleanup(() => observer.disconnect());
  });
  const [editing, setEditing] = createSignal<Project | null>(null);
  const [showEditActions, setShowEditActions] = createSignal(false);
  const [editAction, setEditAction] = createSignal<'commit' | 'discard' | null>(null);
  const snapshot = () => documentStore.snapshot;
  const reviewable = createMemo(() => reviewableRuns());
  const editorCommand = () => store.editorCommand.trim();
  const openPath = () => activeDocumentPath() ?? project()?.documentPath;
  const editorButtonLabel = () => {
    const documentPath = openPath() ?? 'document';
    return editorCommand()
      ? `Open ${documentPath} in ${editorCommand()}`
      : `Configure an editor command in Settings to open ${documentPath}`;
  };

  // Close when the project disappears (removed while open).
  createEffect(() => {
    if (store.activeDocumentProjectId && !project()) closeDocumentWorkspace();
  });

  // Panel state is per workspace: a new project starts from the defaults.
  createEffect(
    on(
      () => project()?.id,
      () => resetWorkspaceUi(),
    ),
  );

  // Opening a workspace selects its agent task; selecting another panel leaves
  // it mounted. On close, restore the previous task if the document still has
  // focus. The agent task is created once the installed
  // agents are known, which may be after the workspace opened.
  const previousActiveTask = store.activeTaskId;
  createEffect(
    on(
      () => [project()?.id, store.availableAgents] as const,
      ([id], previous) => {
        const p = project();
        if (!p) return;
        if (id !== previous?.[0] || isActive()) activateDocumentAgentTask(p);
        else ensureDocumentAgentTask(p);
      },
    ),
  );

  onCleanup(() => {
    if (documentStore.projectId) closeDocumentWorkspace();
    releaseDocumentAgentTask(previousActiveTask);
  });

  function openDocumentInEditor() {
    const currentProject = project();
    const command = editorCommand();
    const path = openPath();
    if (!currentProject || !path || !command) return;
    const documentPath = `${currentProject.path.replace(/\/$/, '')}/${path}`;
    openInEditor(command, documentPath).catch((err) =>
      showNotification(`Editor failed: ${errMessage(err)}`),
    );
  }

  /** The project folder in the system file manager. */
  function openProjectFolder() {
    const currentProject = project();
    if (!currentProject) return;
    revealItemInDir(currentProject.path).catch((err) =>
      showNotification(`Could not open folder: ${errMessage(err)}`),
    );
  }

  function tab(view: DocumentView, label: string) {
    return (
      <button
        type="button"
        class="docws-tab"
        role="tab"
        aria-selected={documentStore.view === view}
        tabIndex={documentStore.view === view ? 0 : -1}
        onKeyDown={(e) => {
          if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          e.stopPropagation();
          const next =
            e.key === 'Home'
              ? 'document'
              : e.key === 'End'
                ? 'history'
                : view === 'document'
                  ? 'history'
                  : 'document';
          setDocumentView(next);
          e.currentTarget.parentElement
            ?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
            ?.focus();
        }}
        onClick={() => setDocumentView(view)}
      >
        {label}
      </button>
    );
  }

  // Stable children keep the agent attached across stacked/wide layout changes
  // and while reading history. Each direction remembers its own split sizes.
  const panes: PanelChild[] = [
    {
      id: 'main',
      absorberWeight: 1.5,
      get minSize() {
        return wide() ? 320 : 120;
      },
      content: () => (
        <>
          <Show when={documentStore.view === 'document' && project()}>
            {(p) => <DocumentPane project={p()} />}
          </Show>
          <Show when={documentStore.view === 'history'}>
            <div class="docws-main" style={{ overflow: 'hidden' }}>
              <HistoryView />
            </div>
          </Show>
        </>
      ),
    },
    {
      id: 'rail',
      get minSize() {
        return wide() ? 320 : 120;
      },
      defaultSize: 420,
      // Keyed: the panel's children read the project from cleanups, which
      // must not go through an accessor while the workspace is closing.
      content: () => (
        <Show when={project()} keyed>
          {(p) => <RightPanel project={p} />}
        </Show>
      ),
    },
  ];

  return (
    <div
      ref={panelRef}
      class="docws-workspace task-column"
      classList={{ active: isActive() }}
      role="region"
      tabIndex={-1}
      aria-label="Document workspace"
      onMouseDown={activate}
      onFocusIn={activate}
    >
      <div class="docws-header" data-tauri-drag-region>
        <div class="docws-title" title={project()?.name}>
          <DocumentIcon size={18} />
          <span>{project()?.name}</span>
        </div>
        <div class="docws-header-actions">
          <button
            type="button"
            class="docws-btn docws-open-editor"
            aria-label={editorButtonLabel()}
            title={editorButtonLabel()}
            disabled={!editorCommand() || !openPath()}
            onClick={() => void openDocumentInEditor()}
          >
            <ExternalLinkIcon />
          </button>
          <button
            type="button"
            class="docws-btn docws-open-editor"
            aria-label={`Open the folder ${project()?.path ?? ''} in the file manager`}
            title={`Open the folder ${project()?.path ?? ''} in the file manager`}
            disabled={!project()}
            onClick={() => openProjectFolder()}
          >
            <FolderOpenIcon />
          </button>
          {/* The sidebar opens a document project as this workspace, so its
              settings are reachable only from here. */}
          <button
            type="button"
            class="docws-btn docws-open-editor"
            aria-label="Project settings: name, folder and agents"
            title="Project settings: name, folder and agents"
            disabled={!project()}
            onClick={() => setEditing(project() ?? null)}
          >
            <GearIcon />
          </button>
          <button
            type="button"
            class="docws-btn docws-open-editor"
            aria-label={store.focusMode ? 'Exit focus mode' : 'Focus on this document'}
            title={store.focusMode ? 'Exit focus mode' : 'Focus on this document'}
            aria-pressed={store.focusMode && isActive()}
            onClick={() => toggleTaskFocusMode(taskId())}
          >
            <Show when={store.focusMode} fallback={<EnterFocusIcon />}>
              <ExitFocusIcon />
            </Show>
          </button>
          <button
            type="button"
            class="docws-btn docws-open-editor docws-close"
            aria-label="Close document workspace"
            title="Close document workspace"
            onClick={() => closeDocumentWorkspace()}
          >
            <CloseIcon />
          </button>
        </div>
        <div class="docws-navigation">
          <div class="docws-tabs" role="tablist" aria-label="Document views">
            {tab('document', 'Document')}
            {tab('history', 'History')}
          </div>
          <Show when={previousDocumentPath()}>
            {(previous) => (
              <button
                type="button"
                class="docws-btn docws-back"
                title={`Back to ${previous()}`}
                aria-label={`Back to ${previous()}`}
                onClick={() => void goBackDocument()}
              >
                ←
              </button>
            )}
          </Show>
          <button
            type="button"
            class="docws-file-path"
            title={`Browse project files · ${openPath() ?? ''}`}
            aria-label={`Browse project files: ${openPath() ?? ''}`}
            onClick={() => setRailTab('files')}
          >
            <span>{openPath()}</span>
            <ChevronDownThinIcon size={12} />
          </button>
          <span class="docws-head-chip" title="Checked-out branch and head commit">
            <GitBranchAltIcon size={12} />
            {snapshot()?.branch ?? 'detached'} · {snapshot()?.headSha?.slice(0, 7) ?? 'no commits'}
          </span>
        </div>
        <Show when={snapshot()?.dirty || documentStore.loading || reviewable().length > 0}>
          <div class="docws-status" role="status">
            <Show when={snapshot()?.dirty}>
              <button
                type="button"
                class="docws-head-chip is-warning is-action"
                title="Commit or discard these edits"
                onClick={() => setShowEditActions(true)}
              >
                uncommitted edits
              </button>
            </Show>
            <Show when={documentStore.loading}>
              <span class="docws-head-chip">loading…</span>
            </Show>
            <Show when={reviewable().length > 0}>
              <button
                type="button"
                class="docws-btn docws-btn-sm docws-btn-primary"
                title="Open the compare view"
                onClick={() => openDocumentCompare(reviewable()[0].id)}
              >
                {reviewable().length} to review
              </button>
            </Show>
          </div>
        </Show>
      </div>
      <Show when={documentStore.error}>
        <div class="docws-banner docws-banner-error" role="alert">
          {documentStore.error}
        </div>
      </Show>
      <div class="docws-body">
        <ResizablePanel
          direction={wide() ? 'horizontal' : 'vertical'}
          persistKey={wide() ? 'docws' : 'docws:stack'}
          style={{ overflow: 'visible' }}
          absorberIds={wide() ? ['main'] : ['main', 'rail']}
          children={panes}
        />
      </div>
      <EditProjectDialog project={editing()} onClose={() => setEditing(null)} />
      <Dialog
        open={showEditActions()}
        width="440px"
        labelledBy="docws-uncommitted-title"
        describedBy="docws-uncommitted-description"
        onClose={() => {
          if (!editAction()) setShowEditActions(false);
        }}
      >
        <h2 id="docws-uncommitted-title" class="docws-dialog-title">
          Commit or discard edits?
        </h2>
        <p id="docws-uncommitted-description" class="docws-dialog-message">
          Commit saves tracked file changes as “Manual edits”. Discard restores tracked files to the
          last commit and cannot be undone.
        </p>
        <div class="docws-dialog-actions">
          <button
            type="button"
            class="docws-btn"
            disabled={!!editAction()}
            autofocus
            onClick={() => setShowEditActions(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="docws-btn docws-btn-danger"
            disabled={!!editAction()}
            onClick={() => {
              setEditAction('discard');
              void discardDocumentEdits().finally(() => {
                setEditAction(null);
                setShowEditActions(false);
              });
            }}
          >
            <Show when={editAction() === 'discard'}>
              <span class="inline-spinner" aria-hidden="true" />
            </Show>
            Discard edits
          </button>
          <button
            type="button"
            class="docws-btn docws-btn-primary"
            disabled={!!editAction()}
            onClick={() => {
              setEditAction('commit');
              void commitDocumentEdits().finally(() => {
                setEditAction(null);
                setShowEditActions(false);
              });
            }}
          >
            <Show when={editAction() === 'commit'}>
              <span class="inline-spinner" aria-hidden="true" />
            </Show>
            Commit edits
          </button>
        </div>
      </Dialog>
      <CandidateOutputDialog />
      <CompareDialog />
    </div>
  );
}
