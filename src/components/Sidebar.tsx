import { createSignal, createEffect, createMemo, onMount, onCleanup, For, Show } from 'solid-js';
import {
  store,
  pickAndAddProject,
  removeProject,
  removeProjectWithTasks,
  toggleNewTaskDialog,
  setActiveTask,
  toggleSidebar,
  reorderTaskVisually,
  getTaskDotStatus,
  getTaskAttentionState,
  getTaskViewportVisibility,
  registerFocusFn,
  unregisterFocusFn,
  focusSidebar,
  unfocusSidebar,
  setTaskFocusedPanel,
  getTaskFocusedPanel,
  getPanelUserSize,
  setPanelUserSize,
  toggleSettingsDialog,
  setProjectsCollapsed,
  uncollapseTask,
  isProjectMissing,
  showNotification,
} from '../store/store';
import type { Project } from '../store/types';
import type { TaskAttentionState } from '../store/store';
import {
  computeGroupedTasks,
  getCoordinatorChildren,
  isCoordinatedChild,
} from '../store/sidebar-order';
import { ConnectPhoneModal } from './ConnectPhoneModal';
import { ConfirmDialog } from './ConfirmDialog';
import { EditProjectDialog } from './EditProjectDialog';
import { ImportWorktreesDialog } from './ImportWorktreesDialog';
import { SidebarFooter } from './SidebarFooter';
import { IconButton } from './IconButton';
import { UpdateButton } from './UpdateButton';
import { StatusDot } from './StatusDot';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { mod } from '../lib/platform';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { ImportableWorktree } from '../ipc/types';

const DRAG_THRESHOLD = 5;
const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_SIZE_KEY = 'sidebar:width';

/** The task list is the primary navigation surface. When both lists are dense,
 *  cap projects after a few visible rows so tasks keep most of the sidebar. */
const TASKS_LIST_MIN_HEIGHT = '180px';
const PROJECTS_LIST_DEFAULT_MAX_HEIGHT = '40vh';
const PROJECTS_LIST_DENSE_MAX_HEIGHT = 'min(24vh, 180px)';
const DENSE_SIDEBAR_LIST_THRESHOLD = 4;

function getAttentionColor(attention: TaskAttentionState): string | null {
  if (attention === 'active') return theme.accent;
  if (attention === 'needs_input') return theme.warning;
  if (attention === 'error') return theme.error;
  if (attention === 'review') return '#c084fc';
  return null;
}

interface OffscreenAttentionInfo {
  attention: TaskAttentionState;
  color: string;
  label: string | null;
}

function getOffscreenAttentionInfo(taskId: string): OffscreenAttentionInfo | null {
  const visibility = getTaskViewportVisibility(taskId);
  if (!visibility || visibility === 'visible') return null;
  const attention = getTaskAttentionState(taskId);
  if (attention === 'idle' || attention === 'ready') return null;
  const color = getAttentionColor(attention) ?? theme.accent;
  const side = visibility === 'offscreen-left' ? 'left' : 'right';
  const prefix = visibility === 'offscreen-left' ? '←' : '→';
  let label: string | null = null;
  if (attention === 'needs_input') label = `${prefix} input (${side})`;
  if (attention === 'error') label = `${prefix} error (${side})`;
  return { attention, color, label };
}

function createOffscreenAttentionState(taskId: () => string) {
  const info = createMemo(() => getOffscreenAttentionInfo(taskId()));
  return {
    hasAttention: () => info() !== null,
    attention: () => info()?.attention,
    color: () => info()?.color ?? theme.accent,
    label: () => info()?.label ?? null,
  };
}

/** Small bot/coordinator icon (16x16 SVG). */
function CoordinatorIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="currentColor"
      style={{ 'flex-shrink': '0', opacity: '0.7' }}
    >
      <path d="M8 1a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V6h3a2 2 0 0 1 2 2v1.27A2 2 0 0 1 15 11a2 2 0 0 1-3 1.73V11a1 1 0 0 0-1-1H9v2.27A2 2 0 0 1 10 14a2 2 0 0 1-4 0c0-.74.4-1.39 1-1.73V10H5a1 1 0 0 0-1 1v1.73A2 2 0 0 1 5 14a2 2 0 0 1-4 0c0-.74.4-1.39 1-1.73V11a2 2 0 0 1-1-1.73V8a2 2 0 0 1 2-2h3V4.73A2 2 0 0 1 6 3a2 2 0 0 1 2-2Z" />
    </svg>
  );
}

export function Sidebar() {
  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null);
  const [editingProject, setEditingProject] = createSignal<Project | null>(null);
  const [showConnectPhone, setShowConnectPhone] = createSignal(false);
  const [importProject, setImportProject] = createSignal<Project | null>(null);
  const [initialImportCandidates, setInitialImportCandidates] = createSignal<
    ImportableWorktree[] | null
  >(null);
  const [dragFromIndex, setDragFromIndex] = createSignal<number | null>(null);
  const [dragFromTaskId, setDragFromTaskId] = createSignal<string | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = createSignal<number | null>(null);
  const [resizing, setResizing] = createSignal(false);
  let taskListRef: HTMLDivElement | undefined;

  const sidebarWidth = () => getPanelUserSize(SIDEBAR_SIZE_KEY) ?? SIDEBAR_DEFAULT_WIDTH;

  // Maps each visible draggable task ID to its visual position (0-based, excluding coordinated children).
  // This keeps drag signals, drop indicators, and data-task-index in the same coordinate space.
  const taskIndexById = createMemo(() => {
    const map = new Map<string, number>();
    let visIdx = 0;
    for (const taskId of store.taskOrder) {
      if (!isCoordinatedChild(taskId)) {
        map.set(taskId, visIdx++);
      }
    }
    return map;
  });

  // Number of visible draggable items (used for the end-of-list drop indicator).
  const draggableTaskCount = createMemo(() => taskIndexById().size);

  const groupedTasks = createMemo(() => computeGroupedTasks());
  const sidebarTaskCount = createMemo(
    () => store.taskOrder.length + store.collapsedTaskOrder.length,
  );
  const projectListMaxHeight = () =>
    store.projects.length >= DENSE_SIDEBAR_LIST_THRESHOLD &&
    sidebarTaskCount() >= DENSE_SIDEBAR_LIST_THRESHOLD
      ? PROJECTS_LIST_DENSE_MAX_HEIGHT
      : PROJECTS_LIST_DEFAULT_MAX_HEIGHT;

  function handleResizeMouseDown(e: MouseEvent) {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth();

    function onMove(ev: MouseEvent) {
      const newWidth = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, startWidth + ev.clientX - startX),
      );
      setPanelUserSize(SIDEBAR_SIZE_KEY, newWidth);
    }

    function onUp() {
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  onMount(() => {
    const el = taskListRef;
    if (el) {
      const handler = (e: MouseEvent) => {
        const target = (e.target as HTMLElement).closest<HTMLElement>('[data-task-index]');
        if (!target) return;
        const visibleIndex = Number(target.dataset.taskIndex);
        // data-task-index is now the visible draggable index; look up the task ID from the visible order
        const draggableOrder = store.taskOrder.filter((id) => !isCoordinatedChild(id));
        const taskId = draggableOrder[visibleIndex];
        if (taskId === undefined || taskId === null) return;
        handleTaskMouseDown(e, taskId, visibleIndex);
      };
      el.addEventListener('mousedown', handler);
      onCleanup(() => el.removeEventListener('mousedown', handler));
    }

    registerFocusFn('sidebar', () => taskListRef?.focus());
    onCleanup(() => unregisterFocusFn('sidebar'));
  });

  createEffect(() => {
    if (store.sidebarFocused) {
      taskListRef?.focus();
    }
  });

  // Scroll the active task into view when it changes
  createEffect(() => {
    const activeId = store.activeTaskId;
    if (!activeId || !taskListRef) return;
    const idx = taskIndexById().get(activeId);
    if (idx === undefined) return;
    const el = taskListRef.querySelector<HTMLElement>(
      `[data-task-index="${CSS.escape(String(idx))}"]`,
    );
    el?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  });

  createEffect(() => {
    const focusedId = store.sidebarFocusedTaskId;
    if (!focusedId || !taskListRef) return;
    const idx = taskIndexById().get(focusedId);
    const el =
      idx !== undefined
        ? taskListRef.querySelector<HTMLElement>(`[data-task-index="${CSS.escape(String(idx))}"]`)
        : taskListRef.querySelector<HTMLElement>(
            `[data-sidebar-task-id="${CSS.escape(focusedId)}"]`,
          );
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  });

  createEffect(() => {
    const projectId = store.sidebarFocusedProjectId;
    if (!projectId) return;
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-project-id="${CSS.escape(projectId)}"]`,
      );
      el?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
  });

  async function handleAddProject() {
    const projectId = await pickAndAddProject();
    if (!projectId) return;

    const project = store.projects.find((entry) => entry.id === projectId) ?? null;
    if (!project) return;
    if (project.isGitRepo === false) return;

    try {
      const candidates = await invoke<ImportableWorktree[]>(IPC.ListImportableWorktrees, {
        projectRoot: project.path,
      });
      if (candidates.length > 0) {
        setInitialImportCandidates(candidates);
        setImportProject(project);
      }
    } catch (err) {
      console.error('Failed to scan importable worktrees:', err);
      showNotification(
        `Couldn't scan existing worktrees: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function computeDropIndex(clientY: number, fromIdx: number): number {
    if (!taskListRef) return fromIdx;
    const items = taskListRef.querySelectorAll<HTMLElement>('[data-task-index]');
    for (let i = 0; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (clientY < midY) return i;
    }
    return items.length;
  }

  function handleTaskMouseDown(e: MouseEvent, taskId: string, visibleIndex: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;

      if (!dragging) {
        dragging = true;
        setDragFromIndex(visibleIndex);
        setDragFromTaskId(taskId);
        document.body.classList.add('dragging-task');
      }

      setDropTargetIndex(computeDropIndex(ev.clientY, visibleIndex));
    }

    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);

      if (dragging) {
        document.body.classList.remove('dragging-task');
        const from = dragFromIndex();
        const to = dropTargetIndex();
        const fromTaskId = dragFromTaskId();
        setDragFromIndex(null);
        setDragFromTaskId(null);
        setDropTargetIndex(null);

        if (from !== null && to !== null && from !== to && fromTaskId !== null) {
          const adjustedTo = to > from ? to - 1 : to;
          reorderTaskVisually(fromTaskId, adjustedTo);
        }
      } else {
        setActiveTask(taskId);
        focusSidebar();
      }
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function abbreviatePath(path: string): string {
    const prefixes = ['/home/', '/Users/'];
    for (const prefix of prefixes) {
      if (path.startsWith(prefix)) {
        const rest = path.slice(prefix.length);
        const slashIdx = rest.indexOf('/');
        if (slashIdx !== -1) return '~' + rest.slice(slashIdx);
        return '~';
      }
    }
    return path;
  }

  function globalIndex(taskId: string): number {
    return taskIndexById().get(taskId) ?? -1;
  }

  let sidebarRef!: HTMLDivElement;

  return (
    <div
      ref={sidebarRef}
      class="sidebar-shell"
      style={{
        width: `${sidebarWidth()}px`,
        'min-width': `${SIDEBAR_MIN_WIDTH}px`,
        'max-width': `${SIDEBAR_MAX_WIDTH}px`,
        display: 'flex',
        'flex-shrink': '0',
        'user-select': resizing() ? 'none' : undefined,
      }}
    >
      <div
        class="sidebar-panel"
        style={{
          flex: '1',
          'min-width': '0',
          display: 'flex',
          'flex-direction': 'column',
          padding: '16px',
          gap: '16px',
          'user-select': 'none',
        }}
      >
        {/* Logo + collapse */}
        <div
          style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}
        >
          <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', padding: '0 2px' }}>
            <svg
              width="24"
              height="24"
              viewBox="0 0 56 56"
              fill="none"
              stroke={theme.fg}
              stroke-width="4"
              style={{ 'flex-shrink': '0' }}
            >
              <line x1="10" y1="6" x2="10" y2="50" />
              <line x1="22" y1="6" x2="22" y2="50" />
              <path d="M30 8 H47 V24 H30" />
              <path d="M49 32 H32 V48 H49" />
            </svg>
            <span
              style={{
                'font-size': sf(15),
                'font-weight': '600',
                color: theme.fg,
                'font-family': "'JetBrains Mono', monospace",
              }}
            >
              ParallelCode
            </span>
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <UpdateButton />
            <IconButton
              icon={
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 2.25a.75.75 0 0 1 .73.56l.2.72a4.48 4.48 0 0 1 1.04.43l.66-.37a.75.75 0 0 1 .9.13l.75.75a.75.75 0 0 1 .13.9l-.37.66c.17.33.31.68.43 1.04l.72.2a.75.75 0 0 1 .56.73v1.06a.75.75 0 0 1-.56.73l-.72.2a4.48 4.48 0 0 1-.43 1.04l.37.66a.75.75 0 0 1-.13.9l-.75.75a.75.75 0 0 1-.9.13l-.66-.37a4.48 4.48 0 0 1-1.04.43l-.2.72a.75.75 0 0 1-.73.56H6.94a.75.75 0 0 1-.73-.56l-.2-.72a4.48 4.48 0 0 1-1.04-.43l-.66.37a.75.75 0 0 1-.9-.13l-.75-.75a.75.75 0 0 1-.13-.9l.37-.66a4.48 4.48 0 0 1-.43-1.04l-.72-.2a.75.75 0 0 1-.56-.73V7.47a.75.75 0 0 1 .56-.73l.72-.2c.11-.36.26-.71.43-1.04l-.37-.66a.75.75 0 0 1 .13-.9l.75-.75a.75.75 0 0 1 .9-.13l.66.37c.33-.17.68-.31 1.04-.43l.2-.72a.75.75 0 0 1 .73-.56H8Zm-.53 3.22a2.5 2.5 0 1 0 1.06 4.88 2.5 2.5 0 0 0-1.06-4.88Z" />
                </svg>
              }
              onClick={() => toggleSettingsDialog(true)}
              title={`Settings (${mod}+,)`}
            />
            <IconButton
              icon={
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
                </svg>
              }
              onClick={() => toggleSidebar()}
              title={`Collapse sidebar (${mod}+B)`}
            />
          </div>
        </div>

        {/* Projects section */}
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '6px',
            flex: '0 1 auto',
            'min-height': '0',
          }}
        >
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              padding: '0 2px',
            }}
          >
            <button
              type="button"
              class="projects-toggle"
              onClick={() => setProjectsCollapsed(!store.projectsCollapsed)}
              aria-expanded={!store.projectsCollapsed}
              aria-controls="sidebar-projects-list"
              title={store.projectsCollapsed ? 'Expand projects' : 'Collapse projects'}
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '4px',
                flex: '1',
                'min-width': '0',
                background: 'transparent',
                border: 'none',
                padding: '2px 4px',
                margin: '0',
                cursor: 'pointer',
                color: theme.fgMuted,
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
                style={{
                  'flex-shrink': '0',
                  transform: store.projectsCollapsed ? 'rotate(-90deg)' : 'none',
                  transition: 'transform 0.15s ease',
                }}
              >
                <path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" />
              </svg>
              <span
                style={{
                  'font-size': sf(12),
                  'text-transform': 'uppercase',
                  'letter-spacing': '0.05em',
                }}
              >
                Projects
              </span>
            </button>
            <IconButton
              icon={
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
                </svg>
              }
              onClick={() => handleAddProject()}
              title="Add project"
              size="sm"
            />
          </div>

          {/* Scrollable project list — outer grid-rows wrapper animates the
              collapse smoothly without needing a measured height. */}
          <div
            class="projects-collapser"
            classList={{ 'is-collapsed': store.projectsCollapsed }}
            aria-hidden={store.projectsCollapsed}
          >
            <div class="projects-clip">
              <div
                id="sidebar-projects-list"
                style={{
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '6px',
                  'min-height': '0',
                  'max-height': projectListMaxHeight(),
                  'overflow-y': 'auto',
                }}
              >
                <For each={store.projects}>
                  {(project) => (
                    <div
                      role="button"
                      tabIndex={0}
                      data-project-id={project.id}
                      onClick={() => setEditingProject(project)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') setEditingProject(project);
                      }}
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        gap: '6px',
                        padding: '4px 6px',
                        'border-radius': '6px',
                        background: isProjectMissing(project.id)
                          ? `color-mix(in srgb, ${theme.warning} 8%, ${theme.bgInput})`
                          : theme.bgInput,
                        'font-size': sf(12),
                        cursor: 'pointer',
                        border:
                          store.sidebarFocused && store.sidebarFocusedProjectId === project.id
                            ? `1.5px solid var(--border-focus)`
                            : '1.5px solid transparent',
                        'flex-shrink': '0',
                      }}
                    >
                      <div
                        style={{
                          width: '8px',
                          height: '8px',
                          'border-radius': '50%',
                          background: project.color,
                          'flex-shrink': '0',
                        }}
                      />
                      <div style={{ flex: '1', 'min-width': '0', overflow: 'hidden' }}>
                        <div
                          style={{
                            color: theme.fg,
                            'font-weight': '500',
                            'white-space': 'nowrap',
                            overflow: 'hidden',
                            'text-overflow': 'ellipsis',
                          }}
                        >
                          {project.name}
                        </div>
                        <div
                          style={{
                            color: isProjectMissing(project.id) ? theme.warning : theme.fgSubtle,
                            'font-size': sf(11),
                            'white-space': 'nowrap',
                            overflow: 'hidden',
                            'text-overflow': 'ellipsis',
                          }}
                        >
                          {isProjectMissing(project.id)
                            ? 'Folder not found'
                            : abbreviatePath(project.path)}
                        </div>
                      </div>
                      <button
                        class="icon-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmRemove(project.id);
                        }}
                        title="Remove project"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: theme.fgSubtle,
                          cursor: 'pointer',
                          'font-size': sf(13),
                          'line-height': '1',
                          padding: '0 2px',
                          'flex-shrink': '0',
                        }}
                      >
                        &times;
                      </button>
                    </div>
                  )}
                </For>

                <Show when={store.projects.length === 0}>
                  <span style={{ 'font-size': sf(11), color: theme.fgSubtle, padding: '0 2px' }}>
                    No projects linked yet.
                  </span>
                </Show>
              </div>
            </div>
          </div>
        </div>

        <div style={{ height: '1px', background: theme.border }} />

        {/* New task / Link project button */}
        <Show
          when={store.projects.length > 0}
          fallback={
            <button
              class="icon-btn"
              onClick={() => handleAddProject()}
              style={{
                background: 'transparent',
                border: `1px solid ${theme.border}`,
                'border-radius': '8px',
                padding: '8px 14px',
                color: theme.fgMuted,
                cursor: 'pointer',
                'font-size': sf(13),
                'font-weight': '500',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                gap: '6px',
                width: '100%',
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
          }
        >
          <button
            class="icon-btn"
            onClick={() => toggleNewTaskDialog(true)}
            style={{
              background: 'transparent',
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '8px 14px',
              color: theme.fgMuted,
              cursor: 'pointer',
              'font-size': sf(13),
              'font-weight': '500',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              gap: '6px',
              width: '100%',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
            </svg>
            New Task
          </button>
        </Show>

        {/* Tasks grouped by project */}
        <div
          ref={taskListRef}
          tabIndex={0}
          onKeyDown={(e) => {
            if (!store.sidebarFocused) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              const focusedProjectId = store.sidebarFocusedProjectId;
              if (focusedProjectId) {
                const project = store.projects.find((p) => p.id === focusedProjectId);
                if (project) setEditingProject(project);
                return;
              }
              const taskId = store.sidebarFocusedTaskId;
              if (taskId) {
                if (store.tasks[taskId]?.collapsed) {
                  uncollapseTask(taskId);
                } else {
                  setActiveTask(taskId);
                  unfocusSidebar();
                  setTaskFocusedPanel(taskId, getTaskFocusedPanel(taskId));
                }
              }
            }
          }}
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '1px',
            flex: '1',
            'min-height': TASKS_LIST_MIN_HEIGHT,
            overflow: 'auto',
            outline: 'none',
          }}
        >
          <For each={store.projects}>
            {(project) => {
              const group = () => groupedTasks().grouped[project.id];
              const activeTasks = () => group()?.active ?? [];
              const collapsedTasks = () => group()?.collapsed ?? [];
              const totalCount = () => activeTasks().length + collapsedTasks().length;
              return (
                <Show when={totalCount() > 0}>
                  <span
                    style={{
                      'font-size': sf(11),
                      color: theme.fgSubtle,
                      'text-transform': 'uppercase',
                      'letter-spacing': '0.05em',
                      'margin-top': '8px',
                      'margin-bottom': '4px',
                      padding: '0 2px',
                      display: 'flex',
                      'align-items': 'center',
                      gap: '5px',
                    }}
                  >
                    <div
                      style={{
                        width: '6px',
                        height: '6px',
                        'border-radius': '50%',
                        background: project.color,
                        'flex-shrink': '0',
                      }}
                    />
                    {project.name} ({totalCount()})
                  </span>
                  <For each={activeTasks()}>
                    {(taskId) => (
                      <TaskEntry
                        taskId={taskId}
                        globalIndex={globalIndex}
                        dragFromIndex={dragFromIndex}
                        dropTargetIndex={dropTargetIndex}
                      />
                    )}
                  </For>
                  <For each={collapsedTasks()}>
                    {(taskId) => <CollapsedTaskEntry taskId={taskId} />}
                  </For>
                </Show>
              );
            }}
          </For>

          {/* Orphaned tasks (no matching project) */}
          <Show
            when={
              groupedTasks().orphanedActive.length + groupedTasks().orphanedCollapsed.length > 0
            }
          >
            <span
              style={{
                'font-size': sf(11),
                color: theme.fgSubtle,
                'text-transform': 'uppercase',
                'letter-spacing': '0.05em',
                'margin-top': '8px',
                'margin-bottom': '4px',
                padding: '0 2px',
              }}
            >
              Other (
              {groupedTasks().orphanedActive.length + groupedTasks().orphanedCollapsed.length})
            </span>
            <For each={groupedTasks().orphanedActive}>
              {(taskId) => (
                <TaskEntry
                  taskId={taskId}
                  globalIndex={globalIndex}
                  dragFromIndex={dragFromIndex}
                  dropTargetIndex={dropTargetIndex}
                />
              )}
            </For>
            <For each={groupedTasks().orphanedCollapsed}>
              {(taskId) => <CollapsedTaskEntry taskId={taskId} />}
            </For>
          </Show>

          <Show when={dropTargetIndex() === draggableTaskCount()}>
            <div class="drop-indicator" />
          </Show>
        </div>

        {/* Connect / Disconnect Phone button */}
        {(() => {
          const connected = () =>
            store.remoteAccess.enabled && store.remoteAccess.connectedClients > 0;
          const accent = () => (connected() ? theme.success : theme.fgMuted);
          return (
            <button
              onClick={() => setShowConnectPhone(true)}
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                padding: '8px 12px',
                margin: '4px 8px',
                background: 'transparent',
                border: `1px solid ${connected() ? theme.success : theme.border}`,
                'border-radius': '8px',
                color: accent(),
                'font-size': sf(13),
                cursor: 'pointer',
                'flex-shrink': '0',
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke={accent()}
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                <line x1="12" y1="18" x2="12.01" y2="18" />
              </svg>
              {connected() ? 'Phone Connected' : 'Connect Phone'}
            </button>
          );
        })()}

        <SidebarFooter />

        <ConnectPhoneModal open={showConnectPhone()} onClose={() => setShowConnectPhone(false)} />

        <EditProjectDialog project={editingProject()} onClose={() => setEditingProject(null)} />
        <ImportWorktreesDialog
          open={importProject() !== null}
          project={importProject()}
          initialCandidates={initialImportCandidates()}
          onClose={() => {
            setImportProject(null);
            setInitialImportCandidates(null);
          }}
        />

        {/* Confirm remove project dialog */}
        {(() => {
          const id = confirmRemove();
          const taskCount = id
            ? [...store.taskOrder, ...store.collapsedTaskOrder].filter(
                (tid) => store.tasks[tid]?.projectId === id,
              ).length
            : 0;
          return (
            <ConfirmDialog
              open={id !== null}
              title="Remove project?"
              message={
                taskCount > 0
                  ? `This project has ${taskCount} open task(s). Removing it will also close all tasks, delete their worktrees and branches.`
                  : 'Are you sure you want to remove this project?'
              }
              confirmLabel={taskCount > 0 ? 'Remove all' : 'Remove'}
              danger
              onConfirm={() => {
                if (id) {
                  if (taskCount > 0) {
                    removeProjectWithTasks(id);
                  } else {
                    removeProject(id);
                  }
                }
                setConfirmRemove(null);
              }}
              onCancel={() => setConfirmRemove(null)}
            />
          );
        })()}
      </div>
      {/* Resize handle */}
      <div
        class={`resize-handle resize-handle-h${resizing() ? ' dragging' : ''}`}
        onMouseDown={handleResizeMouseDown}
      />
    </div>
  );
}

// Coordinator children always render inline under their coordinator regardless of
// their position in taskOrder (they're filtered out of computeGroupedTasks).
// So moving the coordinator itself is sufficient — children follow visually.

// --- Task entry: renders a task row OR a coordinator folder with nested children ---

interface TaskEntryProps {
  taskId: string;
  globalIndex: (taskId: string) => number;
  dragFromIndex: () => number | null;
  dropTargetIndex: () => number | null;
}

function TaskEntry(props: TaskEntryProps) {
  const task = () => store.tasks[props.taskId];
  const isCoordinator = () => task()?.coordinatorMode ?? false;

  return (
    <Show when={task()}>
      <Show
        when={isCoordinator()}
        fallback={
          <TaskRow
            taskId={props.taskId}
            globalIndex={props.globalIndex}
            dragFromIndex={props.dragFromIndex}
            dropTargetIndex={props.dropTargetIndex}
            indented={false}
          />
        }
      >
        <CoordinatorFolder
          taskId={props.taskId}
          globalIndex={props.globalIndex}
          dragFromIndex={props.dragFromIndex}
          dropTargetIndex={props.dropTargetIndex}
        />
      </Show>
    </Show>
  );
}

// --- Coordinator folder: coordinator row + indented children ---

function CoordinatorFolder(props: TaskEntryProps) {
  const task = () => store.tasks[props.taskId];
  const children = createMemo(() => getCoordinatorChildren(props.taskId));
  const childCount = createMemo(() => children().active.length + children().collapsed.length);
  const idx = () => props.globalIndex(props.taskId);
  const offscreenAttention = createOffscreenAttentionState(() => props.taskId);

  return (
    <Show when={task()}>
      {(t) => (
        <>
          <Show when={props.dropTargetIndex() === idx()}>
            <div class="drop-indicator" />
          </Show>
          {/* Coordinator row */}
          <div
            class={`task-item${t().closingStatus === 'removing' ? ' task-item-removing' : ' task-item-appearing'}`}
            data-task-index={idx()}
            onClick={() => {
              setActiveTask(props.taskId);
              focusSidebar();
            }}
            style={{
              padding: '7px 10px',
              'border-radius': '6px',
              background: offscreenAttention.hasAttention()
                ? `color-mix(in srgb, ${offscreenAttention.color()} 10%, transparent)`
                : 'transparent',
              color:
                store.activeTaskId === props.taskId || offscreenAttention.hasAttention()
                  ? theme.fg
                  : theme.fgMuted,
              'font-size': sf(13),
              'font-weight':
                store.activeTaskId === props.taskId || offscreenAttention.hasAttention()
                  ? '500'
                  : '400',
              cursor: props.dragFromIndex() !== null ? 'grabbing' : 'pointer',
              'white-space': 'nowrap',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              opacity: props.dragFromIndex() === idx() ? '0.4' : '1',
              display: 'flex',
              'flex-direction': 'column',
              gap: '1px',
              border:
                store.sidebarFocused && store.sidebarFocusedTaskId === props.taskId
                  ? `1.5px solid var(--border-focus)`
                  : offscreenAttention.hasAttention()
                    ? `1.5px solid color-mix(in srgb, ${offscreenAttention.color()} 38%, transparent)`
                    : '1.5px solid transparent',
            }}
          >
            <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
              <CoordinatorIcon />
              <StatusDot status={getTaskDotStatus(props.taskId)} size="sm" />
              <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', flex: '1' }}>
                {t().name}
              </span>
              <Show when={childCount() > 0}>
                <span
                  style={{
                    'font-size': sf(10),
                    color: theme.fgSubtle,
                    'flex-shrink': '0',
                  }}
                >
                  {childCount()}
                </span>
              </Show>
            </div>
          </div>

          {/* Indented active children */}
          <For each={children().active}>
            {(childId) => (
              <TaskRow
                taskId={childId}
                globalIndex={props.globalIndex}
                dragFromIndex={props.dragFromIndex}
                dropTargetIndex={props.dropTargetIndex}
                indented
              />
            )}
          </For>

          {/* Indented collapsed children */}
          <For each={children().collapsed}>
            {(childId) => <CollapsedTaskEntry taskId={childId} indented />}
          </For>
        </>
      )}
    </Show>
  );
}

// --- Collapsed task entry: also handles coordinator folders in collapsed state ---

function CollapsedTaskEntry(props: { taskId: string; indented?: boolean; coordinatorId?: string }) {
  const task = () => store.tasks[props.taskId];
  // Only top-level coordinators render children — indented entries never recurse
  const isCoordinator = () => !props.indented && (task()?.coordinatorMode ?? false);
  const children = createMemo(() =>
    isCoordinator() ? getCoordinatorChildren(props.taskId) : { active: [], collapsed: [] },
  );
  const childCount = createMemo(() => children().active.length + children().collapsed.length);

  return (
    <Show when={task()}>
      {(t) => (
        <>
          <div
            class="task-item task-item-appearing"
            role="button"
            tabIndex={0}
            data-sidebar-task-id={props.taskId}
            onClick={() => {
              if (props.coordinatorId) {
                uncollapseTask(props.coordinatorId);
                setActiveTask(props.taskId);
              } else {
                uncollapseTask(props.taskId);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (props.coordinatorId) {
                  uncollapseTask(props.coordinatorId);
                  setActiveTask(props.taskId);
                } else {
                  uncollapseTask(props.taskId);
                }
              }
            }}
            title="Click to restore"
            style={{
              padding: '7px 10px',
              'padding-left': props.indented ? '22px' : '10px',
              'border-radius': '6px',
              background: 'transparent',
              color: theme.fgSubtle,
              'font-size': sf(12),
              'font-weight': '400',
              cursor: 'pointer',
              'white-space': 'nowrap',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              opacity: '0.6',
              display: 'flex',
              'flex-direction': 'column',
              gap: '1px',
              border:
                store.sidebarFocused && store.sidebarFocusedTaskId === props.taskId
                  ? `1.5px solid var(--border-focus)`
                  : '1.5px solid transparent',
            }}
          >
            <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
              <Show when={isCoordinator()}>
                <CoordinatorIcon />
              </Show>
              <StatusDot status={getTaskDotStatus(props.taskId)} size="sm" />
              <Show when={t().gitIsolation === 'direct'}>
                <span
                  style={{
                    'font-size': sf(10),
                    'font-weight': '600',
                    padding: '1px 5px',
                    'border-radius': '3px',
                    background: `color-mix(in srgb, ${theme.warning} 12%, transparent)`,
                    color: theme.warning,
                    'flex-shrink': '0',
                    'line-height': '1.5',
                  }}
                >
                  {t().branchName}
                </span>
              </Show>
              <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>{t().name}</span>
              <Show when={isCoordinator() && childCount() > 0}>
                <span
                  style={{
                    'font-size': sf(10),
                    color: theme.fgSubtle,
                    'flex-shrink': '0',
                  }}
                >
                  {childCount()}
                </span>
              </Show>
            </div>
          </div>

          {/* If collapsed coordinator, still show children nested */}
          <Show when={isCoordinator()}>
            <For each={children().active}>
              {(childId) => (
                <CollapsedTaskEntry taskId={childId} indented coordinatorId={props.taskId} />
              )}
            </For>
            <For each={children().collapsed}>
              {(childId) => (
                <CollapsedTaskEntry taskId={childId} indented coordinatorId={props.taskId} />
              )}
            </For>
          </Show>
        </>
      )}
    </Show>
  );
}

// --- Individual task row ---

interface TaskRowProps {
  taskId: string;
  globalIndex: (taskId: string) => number;
  dragFromIndex: () => number | null;
  dropTargetIndex: () => number | null;
  indented: boolean;
}

function TaskRow(props: TaskRowProps) {
  const task = () => store.tasks[props.taskId];
  const idx = () => props.globalIndex(props.taskId);
  const offscreenAttention = createOffscreenAttentionState(() => props.taskId);
  return (
    <Show when={task()}>
      {(t) => (
        <>
          <Show when={!props.indented && props.dropTargetIndex() === idx()}>
            <div class="drop-indicator" />
          </Show>
          <div
            class={`task-item${t().closingStatus === 'removing' ? ' task-item-removing' : ' task-item-appearing'}`}
            data-task-index={props.indented ? undefined : idx()}
            onClick={() => {
              setActiveTask(props.taskId);
              focusSidebar();
            }}
            style={{
              padding: '7px 10px',
              'padding-left': props.indented ? '22px' : '10px',
              'border-radius': '6px',
              background: offscreenAttention.hasAttention()
                ? `color-mix(in srgb, ${offscreenAttention.color()} 10%, transparent)`
                : 'transparent',
              color:
                store.activeTaskId === props.taskId || offscreenAttention.hasAttention()
                  ? theme.fg
                  : theme.fgMuted,
              'font-size': sf(12),
              'font-weight':
                store.activeTaskId === props.taskId || offscreenAttention.hasAttention()
                  ? '500'
                  : '400',
              cursor: props.indented
                ? 'pointer'
                : props.dragFromIndex() !== null
                  ? 'grabbing'
                  : 'pointer',
              'white-space': 'nowrap',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              opacity: !props.indented && props.dragFromIndex() === idx() ? '0.4' : '1',
              display: 'flex',
              'flex-direction': 'column',
              gap: '1px',
              border:
                store.sidebarFocused && store.sidebarFocusedTaskId === props.taskId
                  ? `1.5px solid var(--border-focus)`
                  : offscreenAttention.hasAttention()
                    ? `1.5px solid color-mix(in srgb, ${offscreenAttention.color()} 38%, transparent)`
                    : '1.5px solid transparent',
            }}
          >
            <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
              <StatusDot status={getTaskDotStatus(props.taskId)} size="sm" />
              <Show when={t().gitIsolation === 'direct'}>
                <span
                  style={{
                    'font-size': sf(10),
                    'font-weight': '600',
                    padding: '1px 5px',
                    'border-radius': '3px',
                    background: `color-mix(in srgb, ${theme.warning} 12%, transparent)`,
                    color: theme.warning,
                    'flex-shrink': '0',
                    'line-height': '1.5',
                  }}
                >
                  {t().branchName}
                </span>
              </Show>
              <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>{t().name}</span>
              <Show when={offscreenAttention.label()}>
                {(label) => (
                  <span
                    style={{
                      'font-size': sf(10),
                      color: offscreenAttention.color(),
                      background: `color-mix(in srgb, ${offscreenAttention.color()} 12%, transparent)`,
                      padding: '1px 5px',
                      'border-radius': '3px',
                      'flex-shrink': '0',
                    }}
                  >
                    {label()}
                  </span>
                )}
              </Show>
            </div>
          </div>
        </>
      )}
    </Show>
  );
}
