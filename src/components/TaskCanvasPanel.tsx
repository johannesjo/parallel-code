import {
  For,
  Show,
  createEffect,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import {
  setTaskFocusedPanel,
  isPanelFocused,
  openCanvasDocument,
  openCanvasBrowser,
  openCanvasReasoning,
  openCanvasMindMap,
  activateCanvasTab,
  closeCanvasTab,
  closeTaskCanvas,
  showNotification,
  registerAction,
  unregisterAction,
} from '../store/store';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { canvasTabKey, tabFromKey } from '../lib/canvas-tabs';
import { useFocusRegistration } from '../lib/focus-registration';
import { openFileInEditor } from '../lib/shell';
import { errMessage } from '../lib/log';
import type { CanvasTab, Task } from '../store/types';
import {
  documentTourKind,
  type UnderstandingTourController,
} from '../lib/create-understanding-tour';
import { TOUR_MIN_DOCUMENT_CHARS } from '../../electron/shared/understanding-limits';
import { ConfirmDialog } from './ConfirmDialog';
import { CanvasFilePicker } from './CanvasFilePicker';
import { CanvasTabStrip } from './CanvasTabStrip';
import { TaskBrowserPanel } from './TaskBrowserPanel';

// Lazy: CodeMirror only loads once a document tab is opened.
const TaskCanvasDocument = lazy(() =>
  import('./TaskCanvasDocument').then((m) => ({ default: m.TaskCanvasDocument })),
);

type DocumentTab = Extract<CanvasTab, { path: string }>;
const isDocumentTab = (tab: CanvasTab): tab is DocumentTab => 'path' in tab;

interface TaskCanvasPanelProps {
  task: Task;
  agentId: string;
  isActive: boolean;
  reasoning?: JSX.Element;
  mindmap?: JSX.Element;
  /** Both present: open documents get a Take Tour button in the strip. */
  understanding?: UnderstandingTourController;
  onTakeTour?: (path: string) => void;
}

/**
 * The task's canvas column: a tab per open document, all kept mounted so
 * edits survive switching, with a picker for adding Markdown files.
 */
export function TaskCanvasPanel(props: TaskCanvasPanelProps) {
  let panelRef: HTMLDivElement | undefined;
  let contextMenuRef: HTMLDivElement | undefined;
  onMount(() => {
    useFocusRegistration(`${props.task.id}:canvas`, () => {
      if (!panelRef || panelRef.contains(document.activeElement)) return;
      const graph = panelRef.querySelector('.task-canvas-reasoning-content');
      const target =
        graph?.querySelector<HTMLElement>('[data-record-id][tabindex="0"]') ??
        graph?.querySelector<SVGSVGElement>('.investigation-svg') ??
        panelRef;
      target.focus({ preventScroll: true });
    });
  });
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [dirtyTabs, setDirtyTabs] = createSignal<Record<string, boolean>>({});
  /** Characters per document tab key, so short documents get no tour button. */
  const [tabChars, setTabChars] = createSignal<Record<string, number>>({});
  // The tab a close was asked for while it had unsaved edits; null for the column.
  const [confirmClose, setConfirmClose] = createSignal<string | null | false>(false);
  const [fullscreen, setFullscreen] = createSignal(false);
  // Fullscreen is a fixed, viewport-filling overlay, and this panel stays mounted per task.
  // Left set, a background task's canvas would cover the task the user switched to, and its
  // Escape handler is scoped to panelRef, so it no longer fires once focus has moved away.
  createEffect(() => {
    if (!props.isActive) setFullscreen(false);
  });

  /** Enters fullscreen from a control that unmounts itself in the act.
   *  Focus would land on the document body, out of reach of the Escape
   *  handler above, leaving the overlay with no way back. */
  function enterFullscreen(): void {
    setFullscreen(true);
    panelRef?.focus();
  }
  const [contextMenu, setContextMenu] = createSignal<{
    path: string;
    x: number;
    y: number;
  } | null>(null);

  const tabs = () => props.task.canvasTabs ?? [];
  // Closing the last tab under a fullscreen canvas would leave the window
  // filled with the empty state and no tab strip worth showing.
  createEffect(() => {
    if (tabs().length === 0) setFullscreen(false);
  });
  const active = () => props.task.canvasActiveTab;
  const markdownTabs = () => tabs().filter((tab) => tab.kind === 'markdown');
  // Mind map and reasoning tabs render from props; only file-backed tabs mount documents.
  const documentTabs = () => tabs().filter(isDocumentTab);
  const documentTab = (key: string): DocumentTab | null => {
    const tab = tabFromKey(key);
    return tab && isDocumentTab(tab) ? tab : null;
  };

  createEffect(() => {
    if (!contextMenu()) return;
    requestAnimationFrame(() =>
      contextMenuRef?.querySelector<HTMLButtonElement>('button')?.focus(),
    );
  });

  // Ask for a file only while empty; a concrete tab opened by an agent or user
  // dismisses a picker left open from the panel's initially empty state.
  createEffect(() => {
    active();
    setPickerOpen(tabs().length === 0);
  });

  const setDirty = (key: string, dirty: boolean) =>
    setDirtyTabs((d) => (d[key] === dirty ? d : { ...d, [key]: dirty }));
  const setChars = (key: string, chars: number) =>
    setTabChars((c) => (c[key] === chars ? c : { ...c, [key]: chars }));
  const activeDocumentIsLong = () => {
    const key = active();
    return key !== undefined && (tabChars()[key] ?? 0) >= TOUR_MIN_DOCUMENT_CHARS;
  };

  function requestCloseTab(key: string): void {
    if (dirtyTabs()[key]) setConfirmClose(key);
    else closeCanvasTab(props.task.id, key);
  }

  function requestCloseAll(): void {
    if (Object.values(dirtyTabs()).some(Boolean)) setConfirmClose(null);
    else closeTaskCanvas(props.task.id);
  }

  function requestCloseActiveTab(): void {
    const key = active();
    if (key) requestCloseTab(key);
    else requestCloseAll();
  }

  onMount(() => {
    const actionKey = `${props.task.id}:close-canvas-active-tab`;
    registerAction(actionKey, requestCloseActiveTab);
    onCleanup(() => unregisterAction(actionKey));
  });

  function confirmedClose(): void {
    const target = confirmClose();
    setConfirmClose(false);
    if (typeof target === 'string') closeCanvasTab(props.task.id, target);
    else closeTaskCanvas(props.task.id);
  }

  function handleEditorFocusKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && fullscreen()) {
      e.preventDefault();
      e.stopPropagation();
      setFullscreen(false);
      panelRef?.focus();
      return;
    }
    if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // Keep Escape as the canvas-level way to leave the editor without discarding edits.
    if (
      e.key === 'Escape' &&
      e.target instanceof HTMLElement &&
      e.target.closest('.task-canvas-editor')
    ) {
      e.preventDefault();
      e.stopPropagation();
      panelRef?.focus();
      return;
    }
    if (e.defaultPrevented || e.target !== panelRef || e.key !== 'Enter') return;
    const key = active();
    const tab = key ? tabFromKey(key) : null;
    if (tab?.kind !== 'markdown') return;
    const editor = [...(panelRef?.querySelectorAll<HTMLElement>('[data-path]') ?? [])]
      .find((document) => document.dataset.path === tab.path)
      ?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!editor) return;
    e.preventDefault();
    e.stopPropagation();
    editor.focus();
  }

  function openDocumentContextMenu(e: MouseEvent): void {
    if (!(e.target instanceof Element)) return;
    const tab = e.target.closest<HTMLElement>('[data-canvas-document-path]');
    const document = e.target.closest<HTMLElement>('[data-testid="canvas-document"]');
    const path = tab?.dataset.canvasDocumentPath ?? document?.dataset.path;
    if (!path) return;
    e.preventDefault();
    setContextMenu({
      path,
      x: Math.max(4, Math.min(e.clientX, window.innerWidth - 204)),
      y: Math.max(4, Math.min(e.clientY, window.innerHeight - 76)),
    });
  }

  function openDefaultEditor(path: string): void {
    setContextMenu(null);
    void openFileInEditor(props.task.worktreePath, path).catch((error) =>
      showNotification(`Could not open ${path}: ${errMessage(error)}`),
    );
  }

  function openFullscreenEditor(path: string): void {
    setContextMenu(null);
    activateCanvasTab(props.task.id, canvasTabKey({ kind: 'markdown', path }));
    enterFullscreen();
  }

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      class="task-canvas-panel focusable-panel"
      data-testid="task-canvas"
      data-fullscreen={fullscreen() ? 'true' : 'false'}
      data-panel-focused={isPanelFocused(props.task.id, 'canvas') ? 'true' : 'false'}
      onClick={() => setTaskFocusedPanel(props.task.id, 'canvas')}
      on:focusin={() => setTaskFocusedPanel(props.task.id, 'canvas')}
      on:keydown={handleEditorFocusKey}
      onContextMenu={openDocumentContextMenu}
      style={{
        height: fullscreen() ? '100vh' : '100%',
        width: fullscreen() ? '100vw' : undefined,
        display: 'flex',
        'flex-direction': 'column',
        position: fullscreen() ? 'fixed' : 'relative',
        inset: fullscreen() ? '0' : undefined,
        'z-index': fullscreen() ? '1400' : undefined,
        'border-left': `1px solid ${theme.border}`,
        background: theme.taskPanelBg,
      }}
    >
      {/* Strip and picker share one positioned box so the popover hangs
          under the strip, not under the whole column. */}
      <div style={{ position: 'relative', 'flex-shrink': '0' }}>
        <CanvasTabStrip
          tabs={tabs()}
          active={active()}
          dirty={dirtyTabs()}
          onActivate={(key) => activateCanvasTab(props.task.id, key)}
          onClose={requestCloseTab}
          onAdd={(kind) => {
            setPickerOpen(false);
            if (kind === 'browser') openCanvasBrowser(props.task.id);
            else if (kind === 'mindmap') openCanvasMindMap(props.task.id);
            else if (kind === 'reasoning') openCanvasReasoning(props.task.id);
            else setPickerOpen(true);
          }}
          onCloseAll={requestCloseAll}
          fullscreen={fullscreen()}
          onEnterFullscreen={enterFullscreen}
          onExitFullscreen={() => setFullscreen(false)}
          onOpenInDefaultEditor={openDefaultEditor}
          understanding={props.understanding}
          onTakeTour={activeDocumentIsLong() ? props.onTakeTour : undefined}
          tourKind={(path) => documentTourKind(props.task, path)}
        />
        <Show when={pickerOpen()}>
          <CanvasFilePicker
            worktreePath={props.task.worktreePath}
            current={markdownTabs().map((t) => t.path)}
            onPick={(file) => {
              setPickerOpen(false);
              openCanvasDocument(props.task.id, file);
            }}
            onClose={() => setPickerOpen(false)}
          />
        </Show>
      </div>
      <Show when={tabs().length === 0}>
        <div
          style={{
            flex: '1',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            padding: '24px',
            'text-align': 'center',
            color: theme.fgMuted,
            'font-size': sf(12),
          }}
        >
          Use + to open a Markdown file, browser, mind map, or reasoning view.
        </div>
      </Show>
      <Show when={active() === 'reasoning' || active() === 'mindmap'}>
        <div class="task-canvas-reasoning">
          <div class="task-canvas-reasoning-content">
            {active() === 'mindmap' ? props.mindmap : props.reasoning}
          </div>
        </div>
      </Show>
      {/* Keyed by tab key, not object, so a document survives the list being rewritten. */}
      <For each={documentTabs().map(canvasTabKey)}>
        {(key) => (
          <Show when={documentTab(key)}>
            {(tab) => (
              <Show
                when={tab().kind === 'browser'}
                fallback={
                  <TaskCanvasDocument
                    task={props.task}
                    agentId={props.agentId}
                    path={tab().path}
                    active={active() === key}
                    onDirty={(dirty) => setDirty(key, dirty)}
                    onLength={(chars) => setChars(key, chars)}
                  />
                }
              >
                <TaskBrowserPanel
                  taskId={props.task.id}
                  initialUrl={props.task.browserUrl}
                  active={active() === key && !props.task.closingStatus}
                  onClose={() => requestCloseTab(key)}
                />
              </Show>
            )}
          </Show>
        )}
      </For>
      <ConfirmDialog
        open={confirmClose() !== false}
        title="Discard edits?"
        message={
          typeof confirmClose() === 'string'
            ? 'This tab has unsaved edits. Close it and lose them?'
            : 'The canvas has unsaved edits. Close it and lose them?'
        }
        confirmLabel="Discard"
        danger
        onConfirm={confirmedClose}
        onCancel={() => setConfirmClose(false)}
      />
      <Show when={contextMenu()}>
        {(menu) => (
          <Portal>
            <div
              onPointerDown={() => setContextMenu(null)}
              style={{ position: 'fixed', inset: '0', 'z-index': '1500' }}
            />
            <div
              ref={contextMenuRef}
              role="menu"
              class="canvas-kind-menu"
              aria-label={`Actions for ${menu().path}`}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setContextMenu(null);
                  panelRef?.focus();
                }
              }}
              style={{
                position: 'fixed',
                left: `${menu().x}px`,
                top: `${menu().y}px`,
                'z-index': '1501',
                width: '200px',
                padding: '4px',
                background: theme.bgElevated,
                border: `1px solid ${theme.border}`,
                'border-radius': 'var(--radius-md)',
                'box-shadow': 'var(--shadow-soft)',
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => openDefaultEditor(menu().path)}
                style={contextMenuItemStyle}
              >
                Open in default editor
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => openFullscreenEditor(menu().path)}
                style={contextMenuItemStyle}
              >
                Open in fullscreen editor
              </button>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
}

const contextMenuItemStyle = {
  display: 'block',
  width: '100%',
  padding: '6px 8px',
  background: 'transparent',
  border: 'none',
  'border-radius': 'var(--radius-sm)',
  color: theme.fg,
  cursor: 'pointer',
  'font-family': 'var(--font-ui)',
  'font-size': sf(12),
  'text-align': 'left',
} as const;
