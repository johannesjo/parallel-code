import { claudeSessionUrl } from '../lib/claude-session-url';
import { matchesTaskProjectFilter } from './task-project-filter';
import { batch } from 'solid-js';
import { documentAgentTaskId, isProjectPageAgentTaskId } from '../documents/task-id';
import { store, setStore } from './core';
import { info as logInfo } from '../lib/log';
import {
  getTaskFocusedPanel,
  scheduleTaskFocus,
  setTaskFocusedPanel,
  triggerFocus,
} from './focused-panel';
import { showNotification } from './notification';
import { isPlannableProject, pickAndAddProject } from './projects';
import { matchProject, reorderTask, reorderTaskInTileOrder } from './tasks';
import { closeProjectPages } from './project-pages';
import { restoreFailedDraft } from './task-creation';
import { computeTileOrder } from './sidebar-order';

const AI_TERMINAL_PREFIX = 'ai-terminal:';

function focusedAgentIdForTask(taskId: string, agentIds: string[]): string | null {
  const panel = store.focusedPanel[taskId];
  if (!panel?.startsWith(AI_TERMINAL_PREFIX)) return null;
  const agentId = panel.slice(AI_TERMINAL_PREFIX.length);
  return agentIds.includes(agentId) ? agentId : null;
}

function selectedAgentIdForTask(task: {
  agentIds: string[];
  selectedAgentId?: string;
}): string | null {
  return task.selectedAgentId && task.agentIds.includes(task.selectedAgentId)
    ? task.selectedAgentId
    : null;
}

/** Visible tile order; the single document workspace follows coding tasks. */
export function openPanelOrder(): string[] {
  const taskOrder = computeTileOrder();
  return store.activeDocumentProjectId
    ? [...taskOrder, documentAgentTaskId(store.activeDocumentProjectId)]
    : taskOrder;
}

/** Display name of an open item: a task, a terminal or the document workspace. */
export function openItemName(id: string): string {
  const documentProjectId = store.activeDocumentProjectId;
  return (
    (documentProjectId && id === documentAgentTaskId(documentProjectId)
      ? store.projects.find((p) => p.id === documentProjectId)?.name
      : undefined) ??
    store.tasks[id]?.name ??
    store.terminals[id]?.name ??
    'Open item'
  );
}

/** `keepBoard` keeps the all-tasks board showing; see `closeProjectPages`. */
export function setActiveTask(id: string, opts: { keepBoard?: boolean } = {}): void {
  // Its panel lives on the GitHub page or the board, which an active task would close.
  if (isProjectPageAgentTaskId(id)) return;
  const task = store.tasks[id];
  const terminal = store.terminals[id];
  const isDocument =
    store.activeDocumentProjectId && id === documentAgentTaskId(store.activeDocumentProjectId);
  if (!task && !terminal && !isDocument) return;
  // Activating a snoozed task returns it; the stack says which path did it.
  if ((task?.snoozedUntilCi || task?.snoozedUntil !== undefined) && store.activeTaskId !== id) {
    logInfo('background-tasks', 'activating snoozed task', {
      taskId: id,
      stack: new Error().stack,
    });
  }
  if (!isDocument && !matchesTaskProjectFilter(id)) setStore('taskProjectFilter', null);
  closeProjectPages(opts);
  setStore('newTaskPanelFocused', false);
  setStore('placeholderFocused', false);
  let activeAgentId: string | null = null;
  if (task) {
    activeAgentId =
      focusedAgentIdForTask(id, task.agentIds) ??
      selectedAgentIdForTask(task) ??
      (store.activeAgentId && task.agentIds.includes(store.activeAgentId)
        ? store.activeAgentId
        : (task.agentIds[0] ?? null));
    if (activeAgentId) setStore('tasks', id, 'selectedAgentId', activeAgentId);
  }
  setStore('activeTaskId', id);
  setStore('activeAgentId', activeAgentId);
}

/** Activate a task from a click or tap into its column. Unlike `setActiveTask`,
 *  which keyboard jumps share, this also takes focus away from the sidebar. */
export function activateTaskFromPointer(id: string): void {
  const leavingSidebar = store.sidebarFocused;
  const wasActive = store.activeTaskId === id;
  batch(() => {
    setActiveTask(id);
    // Only when the id was one setActiveTask accepted.
    if (store.activeTaskId === id) setStore('sidebarFocused', false);
  });
  // A column that was already active re-runs none of its focus effects, so
  // nothing else would move DOM focus back into it.
  if (leavingSidebar && wasActive && store.activeTaskId === id) {
    scheduleTaskFocus(id, getTaskFocusedPanel(id));
  }
}

export function setActiveAgent(agentId: string): void {
  setStore('activeAgentId', agentId);
  const taskId = store.activeTaskId;
  const task = taskId ? store.tasks[taskId] : undefined;
  if (task?.agentIds.includes(agentId)) {
    setStore('tasks', taskId as string, 'selectedAgentId', agentId);
  }
}

export function moveActiveTask(direction: 'left' | 'right'): void {
  if (store.newTaskPanelFocused) return;
  const { activeTaskId } = store;
  if (!activeTaskId) return;
  const visibleOrder = computeTileOrder();
  if (visibleOrder.length < 2) return;
  const idx = visibleOrder.indexOf(activeTaskId);
  if (idx === -1) return;
  const target = direction === 'left' ? idx - 1 : idx + 1;
  if (target < 0 || target >= visibleOrder.length) return;
  reorderTaskInTileOrder(activeTaskId, target);
  // Re-focus the moved task and scroll it into view (DOM node move loses focus)
  setTaskFocusedPanel(activeTaskId, getTaskFocusedPanel(activeTaskId));
}

export function jumpToTask(index: number): void {
  // Index against visible panels so Cmd+N matches the left-to-right tile order
  // shown in the main area. Unlike Cmd+Left/Right, it can pick a snoozed tile.
  const id = openPanelOrder()[index];
  if (!id) return;
  setActiveTask(id);
  if (store.sidebarFocused) {
    setStore('sidebarFocusedTaskId', id);
    setStore('sidebarFocusedProjectId', null);
  }
}

export function toggleNewTaskPanel(show?: boolean): void {
  const shouldShow = show ?? !store.showNewTaskPanel;
  if (shouldShow && store.projects.length === 0) {
    showNotification('Add a project first');
    pickAndAddProject();
    return;
  }
  if (shouldShow) {
    if (!store.showNewTaskPanel) restoreFailedDraft();
    // On the board the draft opens in its side panel.
    closeProjectPages({ keepBoard: true });
    setStore('sidebarFocused', false);
    setStore('placeholderFocused', false);
  } else {
    setStore('newTaskPanelFocused', false);
    setStore('newTaskDropUrl', null);
    setStore('newTaskPrefillPrompt', null);
  }
  setStore('showNewTaskPanel', shouldShow);
  if (shouldShow) triggerFocus('new-task');
}

/**
 * Reopens the new-task form for a web session that `claude --teleport` refused
 * because it belongs to another repository. Preselects the project whose folder
 * matches that repository, or none so the user picks one.
 */
export function retryTeleportInRepo(sessionId: string, repo: string): void {
  // Cleared first so an open panel still holding this link applies the project.
  setStore({ lastTeleportProjectId: matchProject(repo), newTaskDropUrl: null });
  setStore('newTaskDropUrl', claudeSessionUrl(sessionId));
  toggleNewTaskPanel(true);
}

/**
 * Opens a blank new-task form for the project. An already open form keeps its
 * draft and project, as with the other prefilled starts.
 */
export function startProjectTask(projectId: string): void {
  if (!store.showNewTaskPanel) {
    setStore('newTaskDropUrl', null);
    // An empty name lets the model name the task from the prompt.
    setStore('newTaskPrefillPrompt', { prompt: '', name: '', projectId });
  }
  toggleNewTaskPanel(true);
}

/**
 * Selects the project whose tasks show. On a plan this switches to the new
 * project's plan; all projects, or one without a plan, show the running tasks.
 */
export function setTaskProjectFilter(projectId: string | null): void {
  batch(() => {
    setStore('taskProjectFilter', projectId);
    if (store.kanbanProjectId && store.kanbanProjectId !== projectId) {
      setStore('kanbanProjectId', isPlannableProject(projectId) ? projectId : null);
    }
    setStore('sidebarFocusedTaskId', null);
    if (!store.activeTaskId || !openPanelOrder().includes(store.activeTaskId)) {
      const nextId = openPanelOrder()[0];
      // Narrowing the board's cards must not close the board.
      if (nextId) setActiveTask(nextId, { keepBoard: true });
      else {
        setStore('activeTaskId', null);
        setStore('activeAgentId', null);
      }
    }
  });
}
