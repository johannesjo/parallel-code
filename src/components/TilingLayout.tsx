import {
  batch,
  Show,
  For,
  createMemo,
  createEffect,
  createSignal,
  on,
  onMount,
  onCleanup,
  ErrorBoundary,
  type JSX,
} from 'solid-js';
import {
  store,
  pickAndAddProject,
  closeTerminal,
  setTaskViewportVisibility,
  taskNeedsAttention,
  getPanelUserSize,
  setPanelUserSize,
  deletePanelUserSize,
  scrollTaskElementIntoView,
  toggleNewTaskPanel,
  armSpCompletion,
} from '../store/store';
import { DocumentWorkspacePanel } from '../documents/DocumentWorkspacePanel';
import { documentAgentTaskId } from '../documents/task-id';
import { scrollTaskIntoView } from '../store/focused-panel';
import { codeProjects } from '../store/projects';
import { closeTask } from '../store/tasks';
import { TaskPanel } from './TaskPanel';
import { TerminalPanel } from './TerminalPanel';
import { NewTaskPanel } from './NewTaskPanel';
import { NewTaskPlaceholder } from './NewTaskPlaceholder';
import { markDirty } from '../lib/terminalFitManager';
import { theme } from '../lib/theme';
import { mod } from '../lib/platform';
import { createCtrlShiftWheelResizeHandler } from '../lib/wheelZoom';
import { shouldAnimateTaskAppearance } from '../lib/reducedMotion';
import { TASK_TILE_DEFAULT_WIDTH, TASK_TILE_MIN_WIDTH } from '../lib/layout-sizes';

const VIEWPORT_EPSILON_PX = 4;

/** Tiling-layout top-level child. Distinct from `PanelChild` because this
 *  layout owns its own horizontal drag model — fixed placeholders, per-panel
 *  min/max widths, pixel-precise persisted sizes — that doesn't map onto the
 *  flex-first ResizablePanel semantics. */
interface TileChild {
  id: string;
  initialSize?: number;
  minSize?: number;
  maxSize?: number;
  fixed?: boolean;
  content: () => JSX.Element;
}

export function TilingLayout() {
  const documentTaskId = () =>
    store.activeDocumentProjectId ? documentAgentTaskId(store.activeDocumentProjectId) : null;
  const hasPanels = () => store.taskOrder.length > 0 || !!documentTaskId();
  const focusMode = () => store.focusMode && hasPanels() && !store.showNewTaskPanel;
  let containerRef: HTMLDivElement | undefined;
  const [hasOverflowLeft, setHasOverflowLeft] = createSignal(false);
  const [hasOverflowRight, setHasOverflowRight] = createSignal(false);
  const [dragging, setDragging] = createSignal<number | null>(null);
  // Transient per-drag width overrides. Written on mousemove, committed to
  // store.panelSizes on mouseup. Keeps autosave's snapshot stable mid-drag.
  const [dragPreview, setDragPreview] = createSignal<Record<string, number>>({});
  let cancelDrag: (() => void) | undefined;
  onCleanup(() => cancelDrag?.());
  let isFirstActiveTaskScroll = true;
  let wasNewTaskPanelOpen = store.showNewTaskPanel;

  function sizeFor(child: TileChild): number {
    const size =
      dragPreview()[child.id] ?? getPanelUserSize(`tiling:${child.id}`) ?? child.initialSize ?? 200;
    return Math.min(child.maxSize ?? Infinity, Math.max(child.minSize ?? 0, size));
  }

  const syncTaskViewportVisibility = (
    entries: Record<string, 'visible' | 'offscreen-left' | 'offscreen-right'>,
  ) => {
    const current = store.taskViewportVisibility;
    const currentKeys = Object.keys(current);
    const nextKeys = Object.keys(entries);
    if (currentKeys.length === nextKeys.length) {
      let changed = false;
      for (const key of nextKeys) {
        if (current[key] !== entries[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
    }
    setTaskViewportVisibility(entries);
  };

  const updateViewportState = () => {
    if (!containerRef || focusMode()) {
      setHasOverflowLeft(false);
      setHasOverflowRight(false);
      syncTaskViewportVisibility({});
      return;
    }

    const maxScrollLeft = containerRef.scrollWidth - containerRef.clientWidth;
    const isOverflowing = maxScrollLeft > 1;
    setHasOverflowLeft(isOverflowing && containerRef.scrollLeft > 1);
    setHasOverflowRight(isOverflowing && containerRef.scrollLeft < maxScrollLeft - 1);

    const containerRect = containerRef.getBoundingClientRect();
    const nextVisibility: Record<string, 'visible' | 'offscreen-left' | 'offscreen-right'> = {};
    const taskEls = containerRef.querySelectorAll<HTMLElement>('[data-task-id]');
    for (const el of taskEls) {
      const taskId = el.dataset.taskId;
      if (!taskId || (!store.tasks[taskId] && taskId !== documentTaskId())) continue;
      const rect = el.getBoundingClientRect();
      if (rect.right <= containerRect.left + VIEWPORT_EPSILON_PX) {
        nextVisibility[taskId] = 'offscreen-left';
      } else if (rect.left >= containerRect.right - VIEWPORT_EPSILON_PX) {
        nextVisibility[taskId] = 'offscreen-right';
      } else {
        nextVisibility[taskId] = 'visible';
      }
    }
    syncTaskViewportVisibility(nextVisibility);
  };

  const offscreenAttention = createMemo(() => {
    let left = false;
    let right = false;
    for (const taskId of store.taskOrder) {
      if (!store.tasks[taskId]) continue;
      const visibility = store.taskViewportVisibility[taskId];
      if (!visibility || visibility === 'visible') continue;
      if (!taskNeedsAttention(taskId)) continue;
      if (visibility === 'offscreen-left') left = true;
      if (visibility === 'offscreen-right') right = true;
      if (left && right) break;
    }
    return { left, right };
  });

  onMount(() => {
    if (!containerRef) return;
    const handleWheel = createCtrlShiftWheelResizeHandler((deltaPx) => {
      if (focusMode()) return;
      // Single batch so every consumer of `panelUserSize` (each panel wrapper)
      // re-runs once per wheel tick instead of once per modified key.
      batch(() => {
        for (const child of panelChildren()) {
          if (child.fixed) continue;
          const current = sizeFor(child);
          const min = child.minSize ?? 30;
          const max = child.maxSize ?? Infinity;
          setPanelUserSize(`tiling:${child.id}`, Math.min(max, Math.max(min, current + deltaPx)));
        }
      });
      requestAnimationFrame(() => updateViewportState());
    });
    let scrollRafPending = false;
    const handleScroll = () => {
      if (scrollRafPending) return;
      scrollRafPending = true;
      requestAnimationFrame(() => {
        scrollRafPending = false;
        updateViewportState();
      });
    };
    let resizeObserver: ResizeObserver | undefined;
    const observeStrip = () => {
      resizeObserver?.disconnect();
      if (!containerRef) return;
      resizeObserver = new ResizeObserver(() => updateViewportState());
      resizeObserver.observe(containerRef);
      const content = containerRef.firstElementChild;
      if (content instanceof HTMLElement) resizeObserver.observe(content);
      updateViewportState();
    };
    const mutationObserver = new MutationObserver(() => observeStrip());

    containerRef.addEventListener('wheel', handleWheel, { passive: false });
    containerRef.addEventListener('scroll', handleScroll, { passive: true });
    mutationObserver.observe(containerRef, { childList: true });
    observeStrip();

    onCleanup(() => {
      containerRef?.removeEventListener('wheel', handleWheel);
      containerRef?.removeEventListener('scroll', handleScroll);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      setTaskViewportVisibility({});
    });
  });

  // Recompute viewport state when panel order/structure changes.
  createEffect(() => {
    void store.taskOrder.join('|');
    void documentTaskId();
    requestAnimationFrame(() => updateViewportState());
  });

  // Scroll the active task panel into view when selection changes.
  // No-op in focus mode: panels are absolute-positioned, scrolling is meaningless.
  createEffect(() => {
    const activeId = store.activeTaskId;
    const newTaskPanelOpen = store.showNewTaskPanel;
    const returningFromNewTask = wasNewTaskPanelOpen && !newTaskPanelOpen;
    const openingNewTask = !wasNewTaskPanelOpen && newTaskPanelOpen;
    wasNewTaskPanelOpen = newTaskPanelOpen;
    if (!containerRef) return;
    if (focusMode()) return;
    // The draft scrolls itself into view. Don't rely on the draft's focus to
    // cancel this scroll: an unfocused window (a link dropped from another app)
    // fires no focus events, and the active task would pull the strip back.
    if (newTaskPanelOpen && (!activeId || openingNewTask)) return;
    if (!activeId) {
      updateViewportState();
      return;
    }

    const el = containerRef.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(activeId)}"]`);
    if (el) {
      // The draft is opened at the far end of the strip. Returning across a
      // long task list must not turn a synchronous Cancel into a long pan.
      const behavior: ScrollBehavior =
        isFirstActiveTaskScroll || returningFromNewTask ? 'instant' : 'smooth';
      isFirstActiveTaskScroll = false;
      scrollTaskIntoView(activeId, behavior);
    }
    requestAnimationFrame(() => updateViewportState());
  });

  createEffect(() => {
    if (!store.showNewTaskPanel) return;
    const frame = requestAnimationFrame(() => {
      const draft = containerRef?.querySelector<HTMLElement>('[data-new-task-panel]');
      if (containerRef && draft) scrollTaskElementIntoView(containerRef, draft, 'instant');
      updateViewportState();
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  // In focus mode: re-fit terminals of the newly active task so xterm picks up
  // the full-width container dimensions (visibility:hidden doesn't trigger
  // ResizeObserver).
  createEffect(() => {
    const activeId = store.activeTaskId;
    if (!focusMode() || !activeId) return;
    const task = store.tasks[activeId];
    if (task) {
      for (const agentId of task.agentIds) markDirty(agentId);
      for (const shellId of task.shellAgentIds) markDirty(shellId);
    }
    const terminal = store.terminals[activeId];
    if (terminal) markDirty(terminal.agentId);
  });

  // Cache TileChild objects by ID so <For> sees stable references
  // and doesn't unmount/remount panels when taskOrder changes.
  const panelCache = new Map<string, TileChild>();

  const panelChildren = createMemo((): TileChild[] => {
    const currentIds = new Set<string>(store.taskOrder);
    if (hasPanels()) currentIds.add('__placeholder');
    if (documentTaskId()) currentIds.add('__document-workspace');
    if (store.showNewTaskPanel) currentIds.add('__new-task');

    // Remove stale entries for deleted tasks
    for (const key of panelCache.keys()) {
      if (!currentIds.has(key)) panelCache.delete(key);
    }

    const panels: TileChild[] = store.taskOrder.map((panelId) => {
      let cached = panelCache.get(panelId);
      if (!cached) {
        cached = {
          id: panelId,
          initialSize: TASK_TILE_DEFAULT_WIDTH,
          minSize: TASK_TILE_MIN_WIDTH,
          content: () => {
            const task = store.tasks[panelId];
            const terminal = store.terminals[panelId];
            const appearanceClass = shouldAnimateTaskAppearance() ? 'task-appearing' : undefined;
            // eslint-disable-next-line solid/components-return-once
            if (!task && !terminal) return <div />;
            return (
              <div
                data-task-id={panelId}
                class={
                  task?.closingStatus === 'removing' || terminal?.closingStatus === 'removing'
                    ? 'task-removing'
                    : appearanceClass
                }
                style={{
                  height: '100%',
                  // The strip owns the vertical gutter, including space for
                  // shadows on themes that use them.
                  padding: store.themePreset.startsWith('islands-')
                    ? focusMode()
                      ? '0'
                      : '0 1px'
                    : '0 3px',
                  'box-sizing': 'border-box',
                }}
                onAnimationEnd={(e) => {
                  if (e.animationName === 'taskAppear')
                    e.currentTarget.classList.remove('task-appearing');
                }}
                onAnimationCancel={(e) => {
                  if (e.animationName === 'taskAppear')
                    e.currentTarget.classList.remove('task-appearing');
                }}
              >
                <ErrorBoundary
                  fallback={(err, reset) => (
                    <div
                      style={{
                        height: '100%',
                        display: 'flex',
                        'flex-direction': 'column',
                        'align-items': 'center',
                        'justify-content': 'center',
                        gap: '12px',
                        padding: '24px',
                        background: theme.islandBg,
                        'border-radius': 'var(--radius-lg)',
                        border: `1px solid ${theme.border}`,
                        color: theme.fgMuted,
                        'font-size': '14px',
                      }}
                    >
                      <div style={{ color: theme.error, 'font-weight': '600' }}>Panel crashed</div>
                      <div
                        style={{
                          'text-align': 'center',
                          'word-break': 'break-word',
                          'max-width': '300px',
                        }}
                      >
                        {String(err)}
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          onClick={reset}
                          style={{
                            background: theme.bgElevated,
                            border: `1px solid ${theme.border}`,
                            color: theme.fg,
                            padding: '6px 16px',
                            'border-radius': 'var(--radius-sm)',
                            cursor: 'pointer',
                          }}
                        >
                          Retry
                        </button>
                        <button
                          onClick={() => {
                            const task = store.tasks[panelId];
                            if (task) {
                              const msg =
                                task.gitIsolation !== 'worktree' || task.externalWorktree
                                  ? 'Close this task? Running agents and shells will be stopped.'
                                  : 'Close this task? The worktree and branch will be deleted.';
                              if (window.confirm(msg)) {
                                armSpCompletion(panelId, { kind: 'closed' });
                                closeTask(panelId);
                              }
                            } else if (store.terminals[panelId]) {
                              closeTerminal(panelId);
                            }
                          }}
                          style={{
                            background: theme.bgElevated,
                            border: `1px solid ${theme.border}`,
                            color: theme.error,
                            padding: '6px 16px',
                            'border-radius': 'var(--radius-sm)',
                            cursor: 'pointer',
                          }}
                        >
                          {store.tasks[panelId] ? 'Close Task' : 'Close Terminal'}
                        </button>
                      </div>
                    </div>
                  )}
                >
                  {task ? (
                    <TaskPanel task={task} isActive={store.activeTaskId === panelId} />
                  ) : terminal ? (
                    <TerminalPanel terminal={terminal} isActive={store.activeTaskId === panelId} />
                  ) : null}
                </ErrorBoundary>
              </div>
            );
          },
        };
        panelCache.set(panelId, cached);
      }
      return cached;
    });

    // One document workspace, kept mounted when its project or active task changes.
    if (documentTaskId()) {
      let documentPanel = panelCache.get('__document-workspace');
      if (!documentPanel) {
        documentPanel = {
          id: '__document-workspace',
          // Leave room for the document and agent to open side by side.
          initialSize: 960,
          minSize: TASK_TILE_MIN_WIDTH,
          content: () => (
            <div
              data-task-id={documentTaskId()}
              style={{
                height: '100%',
                padding: store.themePreset.startsWith('islands-')
                  ? focusMode()
                    ? '0'
                    : '0 1px'
                  : '0 3px',
                'box-sizing': 'border-box',
              }}
            >
              <DocumentWorkspacePanel />
            </div>
          ),
        };
        panelCache.set('__document-workspace', documentPanel);
      }
      panels.push(documentPanel);
    }

    if (store.showNewTaskPanel) {
      let draft = panelCache.get('__new-task');
      if (!draft) {
        draft = {
          id: '__new-task',
          initialSize: TASK_TILE_DEFAULT_WIDTH,
          minSize: TASK_TILE_MIN_WIDTH,
          content: () => (
            <NewTaskPanel open={store.showNewTaskPanel} onClose={() => toggleNewTaskPanel(false)} />
          ),
        };
        panelCache.set('__new-task', draft);
      }
      panels.push(draft);
    }

    if (hasPanels()) {
      let placeholder = panelCache.get('__placeholder');
      if (!placeholder) {
        placeholder = {
          id: '__placeholder',
          initialSize: 54,
          fixed: true,
          content: () => <NewTaskPlaceholder />,
        };
        panelCache.set('__placeholder', placeholder);
      }
      panels.push(placeholder);
    }

    return panels;
  });

  createEffect(
    on(
      () => [focusMode(), ...panelChildren().map((child) => child.id)],
      () => cancelDrag?.(),
    ),
  );

  function handleDragStart(index: number, e: MouseEvent) {
    if (e.button !== 0) return;
    cancelDrag?.();
    const panels = panelChildren();
    const child = panels[index];
    if (!child || child.fixed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startSize = sizeFor(child);
    const minSize = child.minSize ?? 30;
    const maxSize = child.maxSize ?? Infinity;
    const key = `tiling:${child.id}`;
    let latest = startSize;
    setDragging(index);

    function onMove(ev: MouseEvent) {
      latest = Math.min(maxSize, Math.max(minSize, startSize + (ev.clientX - startX)));
      setDragPreview({ [child.id]: latest });
    }
    function cleanup() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', cancel);
      cancelDrag = undefined;
      setDragging(null);
    }
    function cancel() {
      cleanup();
      setDragPreview({});
    }
    function onUp() {
      cleanup();
      batch(() => {
        if (latest !== startSize) setPanelUserSize(key, latest);
        setDragPreview({});
      });
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', cancel);
    cancelDrag = cancel;
  }

  return (
    <div class="tiling-layout-shell">
      <div ref={containerRef} class="tiling-layout-strip" data-tiling-strip>
        <div
          style={{
            display: 'flex',
            'flex-direction': 'row',
            height: '100%',
            position: 'relative',
            ...(focusMode() ? { width: '100%' } : { width: 'fit-content', 'min-width': '100%' }),
          }}
        >
          <Show when={!hasPanels() && !store.showNewTaskPanel}>
            <div
              class="empty-state"
              style={{
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                flex: '1',
                'min-width': '0',
                padding: '20px',
                'box-sizing': 'border-box',
                height: '100%',
                'flex-direction': 'column',
                gap: '16px',
              }}
            >
              <Show
                when={store.collapsedTaskOrder.length === 0}
                fallback={
                  <div style={{ 'text-align': 'center' }}>
                    <div
                      style={{
                        'font-size': '16px',
                        color: theme.fgMuted,
                        'font-weight': '500',
                        'margin-bottom': '6px',
                      }}
                    >
                      All tasks are collapsed
                    </div>
                    <div style={{ 'font-size': '13px', color: theme.fgSubtle }}>
                      Click a task in the sidebar to restore it
                    </div>
                  </div>
                }
              >
                <Show
                  when={codeProjects().length > 0}
                  fallback={
                    <>
                      <div
                        style={{
                          width: '56px',
                          height: '56px',
                          'border-radius': 'var(--radius-lg)',
                          background: theme.islandBg,
                          border: `1px solid ${theme.border}`,
                          display: 'flex',
                          'align-items': 'center',
                          'justify-content': 'center',
                          color: theme.fgSubtle,
                        }}
                      >
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.22.78 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 5 1H1.75Z" />
                        </svg>
                      </div>
                      <div style={{ 'text-align': 'center' }}>
                        <div
                          style={{
                            'font-size': '16px',
                            color: theme.fgMuted,
                            'font-weight': '500',
                            'margin-bottom': '6px',
                          }}
                        >
                          Link your first project to get started
                        </div>
                        <div style={{ 'font-size': '13px', color: theme.fgSubtle }}>
                          A project is a local folder with your code
                        </div>
                      </div>
                      <button
                        onClick={() => pickAndAddProject()}
                        style={{
                          background: theme.bgElevated,
                          border: `1px solid ${theme.border}`,
                          'border-radius': 'var(--radius-md)',
                          padding: '8px 20px',
                          color: theme.fg,
                          cursor: 'pointer',
                          'font-size': '14px',
                          'font-weight': '500',
                          display: 'flex',
                          'align-items': 'center',
                          gap: '6px',
                        }}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.22.78 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 5 1H1.75Z" />
                        </svg>
                        Link Project
                      </button>
                    </>
                  }
                >
                  <div style={{ 'text-align': 'center' }}>
                    <div
                      style={{
                        'font-size': '16px',
                        color: theme.fgMuted,
                        'font-weight': '500',
                        'margin-bottom': '6px',
                      }}
                    >
                      No tasks yet
                    </div>
                    <div style={{ 'font-size': '13px', color: theme.fgSubtle }}>
                      Press{' '}
                      <kbd
                        style={{
                          background: theme.bgElevated,
                          border: `1px solid ${theme.border}`,
                          'border-radius': 'var(--radius-xs)',
                          padding: '2px 6px',
                          'font-family': "'JetBrains Mono', monospace",
                          'font-size': '12px',
                        }}
                      >
                        {mod}+N
                      </kbd>{' '}
                      to create a new task
                    </div>
                  </div>
                </Show>
              </Show>
            </div>
          </Show>
          <For each={panelChildren()}>
            {(child, i) => {
              const wrapperStyle = createMemo((): JSX.CSSProperties => {
                const isPlaceholder = child.id === '__placeholder';
                if (focusMode()) {
                  if (isPlaceholder) return { display: 'none' };
                  const id = child.id === '__document-workspace' ? documentTaskId() : child.id;
                  const isActive = id === store.activeTaskId;
                  return {
                    position: 'absolute',
                    inset: store.themePreset.startsWith('islands-') ? '0 4px 0 0' : '0',
                    width: '100%',
                    height: '100%',
                    visibility: isActive ? 'visible' : 'hidden',
                    'pointer-events': isActive ? 'auto' : 'none',
                    overflow: 'visible',
                  };
                }
                const s = sizeFor(child);
                const min = child.minSize ?? 0;
                return {
                  width: `${s}px`,
                  'min-width': `${min}px`,
                  'flex-shrink': '0',
                  // Panels clip their own content; let their shadows reach
                  // into the gutter between tiles.
                  overflow: isPlaceholder ? 'hidden' : 'visible',
                };
              });
              const showHandle = () =>
                !focusMode() && !child.fixed && i() < panelChildren().length - 1;
              return (
                <>
                  <div
                    style={wrapperStyle()}
                    inert={
                      focusMode() &&
                      (child.id === '__document-workspace' ? documentTaskId() : child.id) !==
                        store.activeTaskId
                    }
                  >
                    {child.content()}
                  </div>
                  <Show when={showHandle()}>
                    <div
                      class={`resize-handle resize-handle-h ${dragging() === i() ? 'dragging' : ''}`}
                      onMouseDown={(e) => handleDragStart(i(), e)}
                      onDblClick={() => {
                        if (dragging() !== null) return;
                        const panels = panelChildren();
                        const left = panels[i()];
                        const right = panels[i() + 1];
                        if (!left || !right) return;
                        deletePanelUserSize([`tiling:${left.id}`, `tiling:${right.id}`]);
                        requestAnimationFrame(() => updateViewportState());
                      }}
                    />
                  </Show>
                </>
              );
            }}
          </For>
        </div>
      </div>

      <Show when={hasOverflowLeft()}>
        <div
          class={`tiling-layout-scroll-affordance tiling-layout-scroll-affordance-left${offscreenAttention().left ? ' tiling-layout-scroll-affordance-attention' : ''}`}
          onClick={() => containerRef?.scrollTo({ left: 0, behavior: 'smooth' })}
          title={
            offscreenAttention().left
              ? 'Tasks need attention off-screen to the left — click to scroll'
              : 'Scroll to start'
          }
        />
      </Show>

      <Show when={hasOverflowRight()}>
        <div
          class={`tiling-layout-scroll-affordance tiling-layout-scroll-affordance-right${offscreenAttention().right ? ' tiling-layout-scroll-affordance-attention' : ''}`}
          onClick={() =>
            containerRef?.scrollTo({
              left: containerRef.scrollWidth - containerRef.clientWidth,
              behavior: 'smooth',
            })
          }
          title={
            offscreenAttention().right
              ? 'Tasks need attention off-screen to the right — click to scroll'
              : 'Scroll to end'
          }
        />
      </Show>
    </div>
  );
}
