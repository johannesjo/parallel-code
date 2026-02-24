import { store, setStore, updateWindowTitle } from './core';
import { showNotification } from './notification';
import { pickAndAddProject } from './projects';
import { reorderTask } from './tasks';

export function setActiveTask(id: string): void {
  const task = store.tasks[id];
  const terminal = store.terminals[id];
  if (!task && !terminal) return;
  setStore('activeTaskId', id);
  setStore('activeAgentId', task?.agentIds[0] ?? null);
  updateWindowTitle(task?.name ?? terminal?.name);
}

export function setActiveAgent(agentId: string): void {
  setStore('activeAgentId', agentId);
}

export function navigateTask(direction: 'left' | 'right'): void {
  const { taskOrder, activeTaskId } = store;
  if (taskOrder.length === 0) return;
  const idx = activeTaskId ? taskOrder.indexOf(activeTaskId) : -1;
  const next =
    direction === 'left' ? Math.max(0, idx - 1) : Math.min(taskOrder.length - 1, idx + 1);
  setActiveTask(taskOrder[next]);
}

export function navigateAgent(direction: 'up' | 'down'): void {
  const { activeTaskId, activeAgentId } = store;
  if (!activeTaskId) return;
  const task = store.tasks[activeTaskId];
  if (!task) return;
  const idx = activeAgentId ? task.agentIds.indexOf(activeAgentId) : -1;
  const next =
    direction === 'up' ? Math.max(0, idx - 1) : Math.min(task.agentIds.length - 1, idx + 1);
  setStore('activeAgentId', task.agentIds[next]);
}

export function moveActiveTask(direction: 'left' | 'right'): void {
  const { taskOrder, activeTaskId } = store;
  if (!activeTaskId || taskOrder.length < 2) return;
  const idx = taskOrder.indexOf(activeTaskId);
  if (idx === -1) return;
  const target = direction === 'left' ? idx - 1 : idx + 1;
  if (target < 0 || target >= taskOrder.length) return;
  reorderTask(idx, target);
}

export function toggleNewTaskDialog(show?: boolean): void {
  const shouldShow = show ?? !store.showNewTaskDialog;
  if (shouldShow && store.projects.length === 0) {
    showNotification('Add a project first');
    pickAndAddProject();
    return;
  }
  if (!shouldShow) {
    setStore('newTaskDropUrl', null);
    setStore('newTaskPrefillPrompt', null);
  }
  setStore('showNewTaskDialog', shouldShow);
}
