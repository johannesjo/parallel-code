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
  untrack,
} from 'solid-js';
import { Portal } from 'solid-js/web';
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
  setDocumentComposerDraft,
  setDocumentSelection,
  setDocumentView,
  setShowResolvedAnnotations,
  undoDeleteDocumentAnnotation,
  type ComposerMode,
  type DocumentView,
  inlineReview,
} from './store';
import { resetWorkspaceUi, workspaceUi } from './workspace-ui';
import {
  activateDocumentAgentTask,
  ensureDocumentAgentTask,
  releaseDocumentAgentTask,
} from './agent-task';
import { documentAgentTaskId } from './task-id';
import { setActiveTask } from '../store/navigation';
import {
  getTaskFocusedPanel,
  isSoloTaskColumn,
  isTaskColumnHighlighted,
  triggerFocus,
} from '../store/focused-panel';
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
import { AttentionLine } from './AttentionLine';
import { InlineReview } from './InlineReview';
import { FilesPopover } from './FilesPopover';
import { QuickEditChip } from './QuickEditChip';
import { CandidateOutputDialog } from './CandidateOutputDialog';
import { BlockEditor } from './BlockEditor';
import { blockEditIn, endBlockEdit, setBlockEditDraft, startBlockEdit } from './block-edit-state';
import { MarkdownEditor } from './MarkdownEditor';
import { afterSavingMarkdown, readMarkdownDraft } from './markdown-editing';
import { ResizablePanel, type PanelChild } from '../components/ResizablePanel';
import { createRenderedBlocks } from './use-blocks';
import { ActionIcon } from './BlockActions';
import { Dialog } from '../components/Dialog';
import { openInEditor, revealItemInDir } from '../lib/shell';
import {
  CollapseAltIcon,
  DocumentIcon,
  ExpandAltIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  FullWidthIcon,
  GearIcon,
  GitGraphIcon,
  MinimizeBarIcon,
  PanelRightIcon,
  UndoIcon,
} from '../components/icons';
import {
  setDocumentFullWidth,
  toggleTaskFocusMode,
  workspaceViewTransitionTypes,
} from '../store/ui';
import { isTerminalPaneOnScreen } from '../lib/terminalPaneVisibility';
import { errMessage } from '../lib/log';
import { withViewTransition } from '../lib/viewTransition';
import { isMarkdownPath } from '../lib/canvas-tabs';
import { showNotification } from '../store/notification';

/** Space between the picked passage and the composer, and from the column's edges. */
const COMPOSER_GAP = 8;

function DocumentPane(props: { project: Project; toolbarSlot: HTMLElement | undefined }) {
  // Floating controls live under document.body, outside the tile's visibility/inert boundary.
  const floatingUiVisible = () => {
    if (editingMarkdown()) return false;
    const taskId = documentAgentTaskId(props.project.id);
    return isTerminalPaneOnScreen({
      taskId,
      // In focus mode a new-task draft takes the pane's place.
      activeTaskId: store.showNewTaskPanel ? null : store.activeTaskId,
      focusMode: store.focusMode,
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
  const composerOpen = () => !!documentStore.composerDraft;

  /** Open the source editor on a block; only blocks that map back to the source qualify. */
  function editBlock(block: DocumentBlock | null) {
    const source = documentStore.snapshot?.content;
    // Mid-render the blocks belong to an older read of the file than the source.
    if (!block || source === undefined || blocks.rendering()) return;
    if (block.startOffset === undefined || block.endOffset === undefined) return;
    // An edit in progress is saved or cancelled first, not dropped.
    if (currentDraft() !== undefined) {
      showNotification('Save or cancel the block you are editing first.');
      return;
    }
    startBlockEdit({
      projectRoot: props.project.path,
      documentPath: documentPath(),
      source,
      block,
    });
  }

  // Markdown blocks are edited where they stand; a page's blocks live inside
  // its own markup, so they are edited in a dialog.
  // An editor opened on another document stays with it.
  const currentEdit = () => blockEditIn(props.project.path, documentPath())?.target ?? null;
  const currentDraft = () => blockEditIn(props.project.path, documentPath())?.draft;
  const inlineEdit = () => (blocks.page() ? null : currentEdit());
  // The file can change under an edit; the editor stays with its block where
  // that has moved (saving then reports the change rather than overwriting it).
  // -1 once the block is gone.
  const editingIndex = () => {
    const block = inlineEdit()?.block;
    if (!block) return undefined;
    // A block's trailing blank lines depend on what follows it.
    const same = (b: DocumentBlock | undefined) =>
      b?.raw.replace(/\n+$/, '') === block.raw.replace(/\n+$/, '');
    const all = blocks.blocks();
    return same(all[block.index]) ? block.index : all.findIndex(same);
  };
  // Rewritten or emptied, the document no longer has the block; rather than
  // stand in for another one, the edit moves to the dialog, its draft in reach
  // to be saved (and refused as stale) or cancelled.
  const editHasNoBlock = () =>
    !!documentStore.snapshot && !blocks.rendering() && editingIndex() === -1;
  // An untouched editor has nothing to keep; it goes the way of its block.
  createEffect(() => {
    const target = currentEdit();
    if (target && editHasNoBlock() && currentDraft() === undefined) endBlockEdit(target);
  });
  function blockSaved() {
    setDocumentSelection(null);
    void refreshDocumentSnapshot();
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

  /** "Rewrite from this": select its passage and open the composer with its text. */
  function makeTask(annotation: DocumentAnnotation) {
    const all = blocks.blocks();
    const loc = placed().located.get(annotation.id) ?? relocateAnchor(annotation.anchor, all);
    if (!loc) return;
    const text = annotation.answer
      ? `${annotation.text}\n\nEarlier answer from ${annotation.answer.agentName}:\n${annotation.answer.text}`
      : annotation.text;
    // An open note draft would otherwise lend its mode and save this as a note.
    const mode = documentStore.composerDraft?.mode === 'task' ? 'task' : 'proposals';
    setDocumentComposerDraft({ text, annotationId: annotation.id, mode });
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

  // The undo offer expires on its own, counted from the latest delete.
  createEffect(
    on(
      () => documentStore.recentlyDeleted.at(-1),
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
    on([selectedRange, blocks.blocks, composerOpen], () => {
      const s = selection();
      // Placed now, before the first paint, so a new comment never shows where
      // the last one was; again once the passage has scrolled into view.
      placeComposer();
      // A comment opens on a passage just clicked, so it is in view; scrolling
      // it would move the prose under a double-click. The comment hangs above
      // the passage when there is no room below.
      const comment = documentStore.composerDraft?.mode === 'note';
      requestAnimationFrame(() => {
        if (composerOpen() && !comment && s && !s.wholeDocument)
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
  // is worked on like any document.
  const isHtml = createMemo(() => isHtmlDocument(documentStore.snapshot?.content));
  const canEditMarkdown = () => isMarkdownPath(documentPath()) && !isHtml();
  const [markdownView, setMarkdownView] = createSignal<'preview' | 'edit'>('preview');
  const [editorOpened, setEditorOpened] = createSignal(false);
  // Where the live editor puts its cursor; `seq` repeats a move to the same line.
  const [reveal, setReveal] = createSignal<{ line: number; seq: number } | undefined>();
  const editingMarkdown = () => canEditMarkdown() && markdownView() === 'edit';
  // File identity, rather than the changing snapshot, owns the editor and its undo history.
  const editorKey = createMemo(() => JSON.stringify([props.project.path, documentPath()]));
  createEffect(
    on(editorKey, () => {
      const hasDraft = !!readMarkdownDraft(props.project.path, documentPath());
      setReveal(undefined);
      setEditorOpened(hasDraft);
      setMarkdownView(hasDraft ? 'edit' : 'preview');
    }),
  );

  // The inline review lives in the preview; the editor would hide it. The
  // store has already saved the draft before it opens the review.
  createEffect(
    on(
      () => !!inlineReview(),
      (open) => {
        if (open && editingMarkdown()) setMarkdownView('preview');
      },
    ),
  );

  // A Comments entry must reveal its passage, saving a Markdown draft first.
  createEffect(
    on(
      () => workspaceUi.focusedAnnotationId,
      (id) => {
        if (!id) return;
        afterSavingMarkdown(() => {
          if (workspaceUi.focusedAnnotationId !== id) return;
          setMarkdownView('preview');
        });
      },
    ),
  );

  // Rendering and relocation can finish after the view switch or editor save.
  createEffect(() => {
    const id = workspaceUi.focusedAnnotationId;
    if (!id || editingMarkdown()) return;
    const loc = placed().located.get(id);
    const frame = requestAnimationFrame(() => {
      const target = loc
        ? blockElement(loc.endBlock)
        : docRef?.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(id)}"]`);
      target?.scrollIntoView({ block: 'center' });
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  /** Typing into the file: opens the live editor, at a block's first line when one is picked. */
  function startEditing() {
    const s = selection();
    const line = s && !s.wholeDocument ? s.startLine : undefined;
    setEditorOpened(true);
    setMarkdownView('edit');
    if (line !== undefined) setReveal({ line, seq: (reveal()?.seq ?? 0) + 1 });
    else requestAnimationFrame(() => mainRef?.querySelector<HTMLElement>('.cm-content')?.focus());
  }

  /** Opens a composer mode, carrying over any text typed in the current one. */
  function openComposer(mode: ComposerMode) {
    setDocumentComposerDraft({
      ...documentStore.composerDraft,
      text: documentStore.composerDraft?.text ?? '',
      mode,
    });
  }
  // A press would move focus out of an open comment first, and that blur saves
  // the comment before its text moves to the new mode.
  const keepComposerFocus = (e: MouseEvent) => e.preventDefault();
  // Switching while a comment saves would post its text a second time.
  const noteSaving = () => documentStore.composerDraft?.noteSaveStatus === 'saving';

  // Keyboard routes to what a click or the block toolbar does on a selected
  // passage: C comments, A asks, E edits its block.
  function passageKey(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"], .cm-editor')) return;
    const key = e.key.toLowerCase();
    // In Edit mode the page, and whatever would open over it, is hidden.
    if (!range() || editingMarkdown() || composerOpen() || noteSaving()) return;
    if (!['c', 'a', 'e'].includes(key)) return;
    e.preventDefault();
    if (key === 'e') editBlock(editableBlock());
    else openComposer(key === 'c' ? 'note' : 'question');
  }

  // A click in the prose, or a closed block editor, leaves the focus on the
  // workspace itself rather than in the page, so the keys are heard there.
  onMount(() => {
    const workspace = mainRef?.closest<HTMLElement>('.docws-workspace');
    if (!workspace) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target === workspace) return passageKey(e);
      // A focused link, button or bubble in the page keeps its own keys.
      // The workspace around the page is focusable too; only the page's own count.
      const el = e.target instanceof Element ? e.target : null;
      const control = el?.closest('a[href], button, [tabindex]');
      if (el && scrollRef?.contains(el) && !(control && scrollRef.contains(control))) passageKey(e);
    };
    workspace.addEventListener('keydown', onKey);
    onCleanup(() => workspace.removeEventListener('keydown', onKey));
  });

  const toolbarLabel = () => {
    if (editingMarkdown()) return 'Edit Markdown directly · autosaves when you pause';
    const s = selection();
    if (!s || s.wholeDocument) return '';
    return s.startLine === s.endLine
      ? `Selected line ${s.startLine}`
      : `Selected lines ${s.startLine}–${s.endLine}`;
  };

  // The label stays quiet; its tooltip names the keys, as no button shows E.
  const toolbarTitle = () =>
    range() && !editingMarkdown() && toolbarLabel()
      ? `${toolbarLabel()} · C comments, A asks, E edits its block`
      : toolbarLabel();

  return (
    <div class="docws-main docws-doc-main" ref={mainRef}>
      {/* The document's actions join the workspace header, so there is one bar. */}
      <Show when={props.toolbarSlot}>
        {(slot) => (
          <Portal mount={slot()} ref={(el) => (el.className = 'docws-toolbar')}>
            <Show
              when={canEditMarkdown() && documentStore.snapshot && !documentStore.snapshot.missing}
            >
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
                  title="Edit the Markdown source; starts at the selected passage"
                  onClick={startEditing}
                >
                  Edit
                </button>
              </div>
            </Show>
            {/* Hidden, not removed, while editing Markdown so the buttons after it stay put. */}
            <button
              type="button"
              ref={reviseRef}
              class="docws-btn docws-btn-sm docws-toolbar-task"
              style={{ visibility: editingMarkdown() ? 'hidden' : 'visible' }}
              disabled={noteSaving() || editingMarkdown()}
              title="Suggest changes to the selected passage or whole document"
              onMouseDown={keepComposerFocus}
              onClick={() => openComposer('proposals')}
            >
              <ActionIcon kind="proposals" />
              Rewrite
            </button>
            {/* Comment and Ask live beside the passage, where a click or the
                block toolbar opens them; the bar keeps to the whole document. */}
            <span class="docws-toolbar-label" title={toolbarTitle()}>
              {toolbarLabel()}
            </span>
            <Show when={documentStore.recentlyDeleted.at(-1)}>
              <span class="docws-undo">
                Deleted a {documentStore.recentlyDeleted.at(-1)?.kind}.
                <button
                  type="button"
                  class="docws-btn docws-btn-sm"
                  onClick={() => void undoDeleteDocumentAnnotation()}
                >
                  <UndoIcon size={12} />
                  Undo
                </button>
              </span>
            </Show>
            <span class="docws-toolbar-spacer" />
            <div class="docws-zoom" role="group" aria-label="Document zoom and width">
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
              {/* An HTML page already takes the whole column, so the toggle would do nothing. */}
              <Show when={!isHtml()}>
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
                </button>
              </Show>
            </div>
            {/* Always holds its place, so the first comment or resolving one
                does not shift the bar. */}
            <label
              class="docws-toggle"
              title="Resolved bubbles collapse to one line"
              style={{
                visibility: resolvedCount() > 0 && !editingMarkdown() ? 'visible' : 'hidden',
              }}
            >
              <input
                type="checkbox"
                checked={documentStore.showResolved}
                disabled={resolvedCount() === 0}
                onChange={(e) => setShowResolvedAnnotations(e.currentTarget.checked)}
              />
              {resolvedCount()} resolved
            </label>
          </Portal>
        )}
      </Show>
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
                reveal={reveal()}
                onRevealed={() => setReveal(undefined)}
                onSaved={refreshDocumentSnapshot}
              />
            </div>
          )}
        </Show>
      </Show>
      {/* Kept mounted while the Markdown source is edited so blocks,
            annotations and scroll position survive the switch. */}
      <div
        class="docws-scroll"
        ref={scrollRef}
        classList={{ 'is-hidden': editingMarkdown() }}
        onMouseUp={(e) => {
          if (!composerOpen() && releasesSelection(e.target)) setDocumentSelection(null);
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
          <AttentionLine projectId={props.project.id} />
          <Show when={placed().detached.length > 0}>
            <div class="docws-detached-section">
              <div class="docws-rail-title">Detached comments</div>
              <div class="docws-empty" style={{ padding: '2px 0 6px' }}>
                Their passages are no longer in the document. Resolve or delete them, or rewrite
                from them on a new selection.
              </div>
              <For each={placed().detached}>
                {(a) => <AnnotationBubble annotation={a} detached onMakeTask={makeTask} />}
              </For>
            </div>
          </Show>
          <Show when={inlineReview()}>
            {(review) => <InlineReview run={review().run} candidate={review().candidate} />}
          </Show>
          <div hidden={!!inlineReview()}>
            <DocumentViewer
              blocks={blocks.blocks()}
              floatingUiVisible={floatingUiVisible()}
              selectable
              composerOpen={composerOpen()}
              selection={range()}
              onSelect={setDocumentSelection}
              renderKey="main"
              page={blocks.page()}
              documentPath={documentPath()}
              onNavigate={(path, anchor) => void navigate(path, anchor)}
              onAction={(action, index, selectedRange) => {
                // Mid-save, switching would post the same text twice.
                if (noteSaving()) return;
                // The same action over the open composer's passage is that
                // composer; a new draft would lose its id and save status.
                if (selectedRange && documentStore.composerDraft?.mode === action) return;
                batch(() => {
                  setDocumentSelection(
                    selectionFromRange(
                      blocks.blocks(),
                      selectedRange ?? { start: index, end: index },
                    ),
                  );
                  setDocumentComposerDraft({
                    text: documentStore.composerDraft?.text ?? '',
                    mode: action,
                  });
                });
              }}
              onEditBlock={(index) => editBlock(blocks.blocks()[index] ?? null)}
              editingBlock={editingIndex()}
              blockEditor={() => (
                <Show keyed when={inlineEdit()}>
                  {(target) => (
                    <BlockEditor
                      target={target}
                      inline
                      draft={untrack(currentDraft)}
                      onDraft={(text) => setBlockEditDraft(target, text)}
                      onClose={() => {
                        endBlockEdit(target);
                        // The focus went with the editor; keep the keys in the workspace.
                        if (document.activeElement === document.body)
                          scrollRef
                            ?.closest<HTMLElement>('.docws-workspace')
                            ?.focus({ preventScroll: true });
                      }}
                      onSaved={blockSaved}
                    />
                  )}
                </Show>
              )}
              onDismissComment={() => {
                batch(() => {
                  setDocumentComposerDraft(null);
                  setDocumentSelection(null);
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
          </div>
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
          classList={{ 'is-anchored': anchorTop() !== null }}
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
              // A click that closed it on something focusable keeps that focus.
              requestAnimationFrame(() => {
                const active = document.activeElement;
                if (!active || active === document.body) reviseRef?.focus({ preventScroll: true });
              });
            }}
          />
        </div>
      </Show>
      <Show keyed when={blocks.page() || editHasNoBlock() ? currentEdit() : null}>
        {(target) => (
          <BlockEditor
            target={target}
            draft={untrack(currentDraft)}
            onDraft={(text) => setBlockEditDraft(target, text)}
            onClose={() => endBlockEdit(target)}
            onSaved={blockSaved}
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
          if (!railCollapsed() && workspaceUi.railTab === 'agent')
            triggerFocus(`${id}:${getTaskFocusedPanel(id)}`);
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
  const quickEditProject = () => {
    const p = project();
    return p?.quickEditSource ? { ...p, quickEditSource: p.quickEditSource } : undefined;
  };
  const railCollapsed = () => project()?.documentPanelCollapsed !== false;
  const [toolbarSlot, setToolbarSlot] = createSignal<HTMLElement>();
  const [editAction, setEditAction] = createSignal<'commit' | 'discard' | null>(null);
  const snapshot = () => documentStore.snapshot;
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
    // A quick edit's copy is private; the editor gets the file the user knows.
    const documentPath =
      currentProject.quickEditSource ?? `${currentProject.path.replace(/\/$/, '')}/${path}`;
    openInEditor(command, documentPath).catch((err) =>
      showNotification(`Editor failed: ${errMessage(err)}`),
    );
  }

  /** The project folder, or a quick edit's original file, in the system file manager. */
  const folderTarget = () => project()?.quickEditSource ?? project()?.path ?? '';
  const folderLabel = () => {
    const source = project()?.quickEditSource;
    return source
      ? `Show ${source} in the file manager`
      : `Open the folder ${project()?.path ?? ''} in the file manager`;
  };
  function openProjectFolder() {
    if (!project()) return;
    revealItemInDir(folderTarget()).catch((err) =>
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
            {(p) => <DocumentPane project={p()} toolbarSlot={toolbarSlot()} />}
          </Show>
          <Show when={documentStore.view === 'history'}>
            <div class="docws-main" style={{ overflow: 'hidden' }}>
              <div class="docws-history-actions">
                {/* Reserved when clean so the buttons do not shift. */}
                <span style={{ visibility: snapshot()?.dirty ? 'visible' : 'hidden' }}>
                  Changed since last version
                </span>
                <button
                  type="button"
                  class="docws-btn docws-btn-sm"
                  disabled={!snapshot()?.dirty || !!editAction()}
                  title="Save all tracked file changes in this project as a version"
                  onClick={() => {
                    setEditAction('commit');
                    void commitDocumentEdits().finally(() => setEditAction(null));
                  }}
                >
                  Save version
                </button>
                <button
                  type="button"
                  class="docws-btn docws-btn-sm"
                  disabled={!snapshot()?.dirty || !!editAction()}
                  onClick={() => setShowEditActions(true)}
                >
                  Restore last version…
                </button>
              </div>
              <HistoryView />
            </div>
          </Show>
        </>
      ),
    },
    {
      id: 'rail',
      resizeLabel: 'Resize side rail',
      get minSize() {
        return wide() ? 320 : 120;
      },
      defaultSize: 360,
      // Keyed: the panel's children read the project from cleanups, which
      // must not go through an accessor while the workspace is closing.
      content: () => (
        <Show when={project()} keyed>
          {(p) => <RightPanel project={p} visible={!railCollapsed()} />}
        </Show>
      ),
    },
  ];

  return (
    <div
      ref={panelRef}
      class="docws-workspace task-column"
      classList={{
        active: isTaskColumnHighlighted(taskId()) && !isSoloTaskColumn(),
        solo: isSoloTaskColumn(),
      }}
      role="region"
      tabIndex={-1}
      aria-label="Document workspace"
      onMouseDown={activate}
      onFocusIn={activate}
    >
      <div class="docws-header" data-tauri-drag-region aria-busy={documentStore.loading}>
        <div class="docws-navigation">
          <span class="docws-title" title={project()?.name}>
            <DocumentIcon size={18} />
            <span>{project()?.name}</span>
          </span>
          <Show when={quickEditProject()}>{(quick) => <QuickEditChip project={quick()} />}</Show>
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
          <FilesPopover
            projectRoot={project()?.path ?? ''}
            openPath={openPath()}
            recentPaths={project()?.documentRecentPaths ?? []}
          />
          <Show when={documentStore.view === 'history'}>
            <span class="docws-head-chip" title="Checked-out branch and head commit">
              <GitGraphIcon size={12} />
              {snapshot()?.branch ?? 'detached'} ·{' '}
              {snapshot()?.headSha?.slice(0, 7) ?? 'no commits'}
            </span>
          </Show>
        </div>
        <div class="docws-header-tools" ref={setToolbarSlot} />
        {/* aria-busy is not announced; this live region says what the dimmed path shows. */}
        <span class="dialog-sr-only" role="status">
          {documentStore.loading ? 'Loading document…' : ''}
        </span>
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
            aria-label={folderLabel()}
            title={folderLabel()}
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
            onClick={() => {
              const id = taskId();
              withViewTransition(
                () => toggleTaskFocusMode(id),
                workspaceViewTransitionTypes(store.focusMode ? 'tiles' : 'focus'),
              );
            }}
          >
            {/* Unfocused shows the corners-in glyph (enter focus); focused shows corners-out. */}
            <Show when={store.focusMode} fallback={<CollapseAltIcon />}>
              <ExpandAltIcon />
            </Show>
          </button>
          <button
            type="button"
            class="docws-btn docws-open-editor"
            aria-label="Side panel"
            title={
              railCollapsed()
                ? 'Show the agent, runs and comments'
                : 'Hide the agent, runs and comments'
            }
            aria-pressed={!railCollapsed()}
            onClick={() => {
              const p = project();
              if (p) updateProject(p.id, { documentPanelCollapsed: !railCollapsed() });
            }}
          >
            <PanelRightIcon />
          </button>
          {/* Minimize, not close: the project stays open in the sidebar and the
              workspace reopens from there, while an X on a task means closing it
              for good. Comment drafts survive; the view and an unsent Rewrite or
              Ask do not. */}
          <button
            type="button"
            class="docws-btn docws-open-editor"
            aria-label="Minimize document workspace"
            title="Minimize · reopen from the sidebar"
            onClick={() => closeDocumentWorkspace()}
          >
            <MinimizeBarIcon />
          </button>
        </div>
      </div>
      <Show when={documentStore.error}>
        <div class="docws-banner docws-banner-error" role="alert">
          {documentStore.error}
        </div>
      </Show>
      <div class="docws-body">
        <ResizablePanel
          class={railCollapsed() ? 'docws-split is-rail-collapsed' : 'docws-split'}
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
          Restore the last saved version?
        </h2>
        <p id="docws-uncommitted-description" class="docws-dialog-message">
          This replaces all tracked file changes in this project with the last saved version.
          Changes since that version will be lost. This cannot be undone.
          <Show when={project()?.quickEditSource}>
            {(source) => <> The original at {source()} is restored to that version too.</>}
          </Show>
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
              void discardDocumentEdits()
                .then((restored) => {
                  if (restored) setShowEditActions(false);
                })
                .finally(() => setEditAction(null));
            }}
          >
            <Show when={editAction() === 'discard'}>
              <span class="inline-spinner" aria-hidden="true" />
            </Show>
            Restore last version
          </button>
        </div>
      </Dialog>
      <CandidateOutputDialog />
      <CompareDialog />
    </div>
  );
}
