import { batch } from 'solid-js';
import { documentAgentTaskId } from '../documents/task-id';
import { store, setStore } from './core';
import {
  getTaskFocusedPanel,
  scheduleTaskFocus,
  setTaskFocusedPanel,
  triggerFocus,
} from './focused-panel';
import { showNotification } from './notification';
import { pickAndAddProject } from './projects';
import { reorderTask } from './tasks';

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
  return store.activeDocumentProjectId
    ? [...store.taskOrder, documentAgentTaskId(store.activeDocumentProjectId)]
    : store.taskOrder;
}

export function setActiveTask(id: string): void {
  const task = store.tasks[id];
  const terminal = store.terminals[id];
  const isDocument =
    store.activeDocumentProjectId && id === documentAgentTaskId(store.activeDocumentProjectId);
  if (!task && !terminal && !isDocument) return;
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
  const { taskOrder, activeTaskId } = store;
  if (!activeTaskId || taskOrder.length < 2) return;
  const idx = taskOrder.indexOf(activeTaskId);
  if (idx === -1) return;
  const target = direction === 'left' ? idx - 1 : idx + 1;
  if (target < 0 || target >= taskOrder.length) return;
  reorderTask(idx, target);
  // Re-focus the moved task and scroll it into view (DOM node move loses focus)
  setTaskFocusedPanel(activeTaskId, getTaskFocusedPanel(activeTaskId));
}

export function jumpToTask(index: number): void {
  // Index against visible panels so Cmd+N matches the left-to-right tile order
  // shown in the main area (and the order Cmd+Left/Right cycles through).
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
