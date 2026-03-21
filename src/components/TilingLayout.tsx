import { Show, For, createMemo, createEffect, ErrorBoundary } from 'solid-js';
import { store, pickAndAddProject, closeTerminal } from '../store/store';
import { closeTask } from '../store/tasks';
import type { PanelChild } from './ResizablePanel';
import { TaskPanel } from './TaskPanel';
import { TerminalPanel } from './TerminalPanel';
import { NewTaskPlaceholder } from './NewTaskPlaceholder';
import { markDirty } from '../lib/terminalFitManager';
import { theme } from '../lib/theme';
import { mod } from '../lib/platform';

export function TilingLayout() {
  let containerRef: HTMLDivElement | undefined;

  // Scroll the active task panel into view when selection changes
  createEffect(() => {
    const activeId = store.activeTaskId;
    if (!activeId || !containerRef) return;
    const el = containerRef.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(activeId)}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  });

  // When switching tasks in focus mode, mark all terminals of the newly active
  // task as dirty so they re-fit to the correct size.
  createEffect(() => {
    const activeId = store.activeTaskId;
    if (!store.focusMode || !activeId) return;
    const task = store.tasks[activeId];
    if (task) {
      for (const agentId of task.agentIds) markDirty(agentId);
      for (const shellId of task.shellAgentIds) markDirty(shellId);
    }
    const terminal = store.terminals[activeId];
    if (terminal) markDirty(terminal.agentId);
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
          minSize: 520,
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
                style={{ height: '100%', padding: '6px 3px' }}
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
                        'font-size': '13px',
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
                              const msg = task.directMode
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
    <div
      ref={containerRef}
      style={{
        flex: '1',
        'overflow-x': 'auto',
        'overflow-y': 'hidden',
        height: '100%',
        padding: '2px 4px',
      }}
    >
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
                      'font-size': '15px',
                      color: theme.fgMuted,
                      'font-weight': '500',
                      'margin-bottom': '6px',
                    }}
                  >
                    All tasks are collapsed
                  </div>
                  <div style={{ 'font-size': '12px', color: theme.fgSubtle }}>
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
                          'font-size': '15px',
                          color: theme.fgMuted,
                          'font-weight': '500',
                          'margin-bottom': '6px',
                        }}
                      >
                        Link your first project to get started
                      </div>
                      <div style={{ 'font-size': '12px', color: theme.fgSubtle }}>
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
                        'font-size': '13px',
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
                    'font-size': '24px',
                    color: theme.fgSubtle,
                  }}
                >
                  +
                </div>
                <div style={{ 'text-align': 'center' }}>
                  <div
                    style={{
                      'font-size': '15px',
                      color: theme.fgMuted,
                      'font-weight': '500',
                      'margin-bottom': '6px',
                    }}
                  >
                    No tasks yet
                  </div>
                  <div style={{ 'font-size': '12px', color: theme.fgSubtle }}>
                    Press{' '}
                    <kbd
                      style={{
                        background: theme.bgElevated,
                        border: `1px solid ${theme.border}`,
                        'border-radius': '4px',
                        padding: '2px 6px',
                        'font-family': "'JetBrains Mono', monospace",
                        'font-size': '11px',
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
        <div
          style={{
            display: 'flex',
            'flex-direction': 'row',
            width: '100%',
            'min-width': '100%',
            height: '100%',
            position: 'relative',
          }}
        >
          <For each={panelChildren()}>
            {(child) => {
              const isPlaceholder = child.id === '__placeholder';
              const hidden = () =>
                store.focusMode && !isPlaceholder && child.id !== store.activeTaskId;
              const hidePlaceholder = () => store.focusMode && isPlaceholder;
              return (
                <div
                  style={{
                    // Focus mode: stack all panels on top of each other at full size
                    // so terminals always compute correct dimensions.
                    // Normal mode: standard flex row layout.
                    ...(store.focusMode && !isPlaceholder
                      ? {
                          position: hidden() ? 'absolute' : 'relative',
                          inset: '0',
                          width: '100%',
                          height: '100%',
                          visibility: hidden() ? 'hidden' : undefined,
                          'pointer-events': hidden() ? 'none' : undefined,
                        }
                      : {
                          flex: isPlaceholder ? '0 0 54px' : '1 1 0px',
                          'min-width': isPlaceholder ? undefined : '520px',
                          height: '100%',
                          display: hidePlaceholder() ? 'none' : undefined,
                        }),
                    overflow: 'hidden',
                  }}
                >
                  {child.content()}
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
