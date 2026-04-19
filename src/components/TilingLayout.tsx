import {
  Show,
  createMemo,
  createEffect,
  createSignal,
  onMount,
  onCleanup,
  ErrorBoundary,
} from 'solid-js';
import {
  store,
  pickAndAddProject,
  closeTerminal,
  setTaskViewportVisibility,
  taskNeedsAttention,
} from '../store/store';
import { closeTask } from '../store/tasks';
import { ResizablePanel, type PanelChild, type ResizablePanelHandle } from './ResizablePanel';
import { TaskPanel } from './TaskPanel';
import { TerminalPanel } from './TerminalPanel';
import { NewTaskPlaceholder } from './NewTaskPlaceholder';
import { theme } from '../lib/theme';
import { mod } from '../lib/platform';
import { createCtrlShiftWheelResizeHandler } from '../lib/wheelZoom';

const VIEWPORT_EPSILON_PX = 4;

export function TilingLayout() {
  let containerRef: HTMLDivElement | undefined;
  let panelHandle: ResizablePanelHandle | undefined;
  const [hasOverflowLeft, setHasOverflowLeft] = createSignal(false);
  const [hasOverflowRight, setHasOverflowRight] = createSignal(false);

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
    if (!containerRef) {
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
      if (!taskId || !store.tasks[taskId]) continue;
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
      panelHandle?.resizeAll(deltaPx);
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
    requestAnimationFrame(() => updateViewportState());
  });

  // Scroll the active task panel into view when selection changes
  createEffect(() => {
    const activeId = store.activeTaskId;
    if (!containerRef) return;
    if (!activeId) {
      updateViewportState();
      return;
    }

    const el = containerRef.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(activeId)}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    requestAnimationFrame(() => updateViewportState());
  });
  // Cache PanelChild objects by ID so <For> sees stable references
  // and doesn't unmount/remount panels when taskOrder changes.
  const panelCache = new Map<string, PanelChild>();

  const panelChildren = createMemo((): PanelChild[] => {
    const currentIds = new Set<string>(store.taskOrder);
    currentIds.add('__placeholder');

    // Remove stale entries for deleted tasks
    for (const key of panelCache.keys()) {
      if (!currentIds.has(key)) panelCache.delete(key);
    }

    const panels: PanelChild[] = store.taskOrder.map((panelId) => {
      let cached = panelCache.get(panelId);
      if (!cached) {
        cached = {
          id: panelId,
          initialSize: 520,
          minSize: 300,
          content: () => {
            const task = store.tasks[panelId];
            const terminal = store.terminals[panelId];
            // eslint-disable-next-line solid/components-return-once
            if (!task && !terminal) return <div />;
            return (
              <div
                data-task-id={panelId}
                class={
                  task?.closingStatus === 'removing' || terminal?.closingStatus === 'removing'
                    ? 'task-removing'
                    : 'task-appearing'
                }
                style={{ height: '100%', padding: '6px 3px', 'box-sizing': 'border-box' }}
                onAnimationEnd={(e) => {
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
                        'border-radius': '12px',
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
                            'border-radius': '6px',
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
                                task.gitIsolation === 'direct' || task.externalWorktree
                                  ? 'Close this task? Running agents and shells will be stopped.'
                                  : 'Close this task? The worktree and branch will be deleted.';
                              if (window.confirm(msg)) closeTask(panelId);
                            } else if (store.terminals[panelId]) {
                              closeTerminal(panelId);
                            }
                          }}
                          style={{
                            background: theme.bgElevated,
                            border: `1px solid ${theme.border}`,
                            color: theme.error,
                            padding: '6px 16px',
                            'border-radius': '6px',
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

    return panels;
  });

  return (
    <div class="tiling-layout-shell">
      <div ref={containerRef} class="tiling-layout-strip">
        <Show
          when={store.taskOrder.length > 0}
          fallback={
            <div
              class="empty-state"
              style={{
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                width: '100%',
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
                  when={store.projects.length > 0}
                  fallback={
                    <>
                      <div
                        style={{
                          width: '56px',
                          height: '56px',
                          'border-radius': '16px',
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
                          'border-radius': '8px',
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
                  <div
                    style={{
                      width: '56px',
                      height: '56px',
                      'border-radius': '16px',
                      background: theme.islandBg,
                      border: `1px solid ${theme.border}`,
                      display: 'flex',
                      'align-items': 'center',
                      'justify-content': 'center',
                      'font-size': '25px',
                      color: theme.fgSubtle,
                    }}
                  >
                    +
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
                      No tasks yet
                    </div>
                    <div style={{ 'font-size': '13px', color: theme.fgSubtle }}>
                      Press{' '}
                      <kbd
                        style={{
                          background: theme.bgElevated,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '4px',
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
          }
        >
          <ResizablePanel
            direction="horizontal"
            children={panelChildren()}
            fitContent
            persistKey="tiling"
            onHandle={(h) => {
              panelHandle = h;
            }}
          />
        </Show>
      </div>

      <Show when={hasOverflowLeft()}>
        <div
          class={`tiling-layout-scroll-affordance tiling-layout-scroll-affordance-left${offscreenAttention().left ? ' tiling-layout-scroll-affordance-attention' : ''}`}
          title={
            offscreenAttention().left ? 'Tasks need attention off-screen to the left' : undefined
          }
        />
      </Show>

      <Show when={hasOverflowRight()}>
        <div
          class={`tiling-layout-scroll-affordance tiling-layout-scroll-affordance-right${offscreenAttention().right ? ' tiling-layout-scroll-affordance-attention' : ''}`}
          title={
            offscreenAttention().right ? 'Tasks need attention off-screen to the right' : undefined
          }
        />
      </Show>
    </div>
  );
}
