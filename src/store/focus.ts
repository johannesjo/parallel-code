import { batch } from 'solid-js';
import { store, setStore } from './core';
import { setActiveTask } from './navigation';

// Imperative focus registry: components register focus callbacks on mount
const focusRegistry = new Map<string, () => void>();
const actionRegistry = new Map<string, () => void>();

export function registerFocusFn(key: string, fn: () => void): void {
  focusRegistry.set(key, fn);
}

export function unregisterFocusFn(key: string): void {
  focusRegistry.delete(key);
}

export function triggerFocus(key: string): void {
  focusRegistry.get(key)?.();
}

export function registerAction(key: string, fn: () => void): void {
  actionRegistry.set(key, fn);
}

export function unregisterAction(key: string): void {
  actionRegistry.delete(key);
}

export function triggerAction(key: string): void {
  actionRegistry.get(key)?.();
}

// --- Dynamic grid-based spatial navigation ---
//
// The grid is built per-task based on its shell count:
//
//        col 0           col 1         col 2 ...
// row 0: notes           changed-files
// row 1: shell-toolbar                           (always present)
// row 2: shell:0         shell:1       shell:2   (only if shells exist)
// row 3: ai-terminal
// row 4: prompt

function buildGrid(panelId: string): string[][] {
  const task = store.tasks[panelId];
  if (task) {
    const grid: string[][] = [['title'], ['notes', 'changed-files'], ['shell-toolbar']];
    if (task.shellAgentIds.length > 0) {
      grid.push(task.shellAgentIds.map((_, i) => `shell:${i}`));
    }
    grid.push(['ai-terminal']);
    grid.push(['prompt']);
    return grid;
  }

  // Terminal panel: just title + terminal
  return [['title'], ['terminal']];
}

/** The panel to focus when navigating into a task or terminal. */
function defaultPanelFor(panelId: string): string {
  return store.tasks[panelId] ? 'prompt' : 'terminal';
}

interface GridPos {
  row: number;
  col: number;
}

function findInGrid(grid: string[][], cell: string): GridPos | null {
  for (let row = 0; row < grid.length; row++) {
    const col = grid[row].indexOf(cell);
    if (col !== -1) return { row, col };
  }
  return null;
}

export function getTaskFocusedPanel(taskId: string): string {
  return store.focusedPanel[taskId] ?? defaultPanelFor(taskId);
}

export function setTaskFocusedPanel(taskId: string, panel: string): void {
  setStore('focusedPanel', taskId, panel);
  setStore('sidebarFocused', false);
  setStore('placeholderFocused', false);
  triggerFocus(`${taskId}:${panel}`);
  scrollTaskIntoView(taskId);
}

function scrollTaskIntoView(taskId: string): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  });
}

export function focusSidebar(): void {
  setStore('sidebarFocused', true);
  setStore('placeholderFocused', false);
  setStore('sidebarFocusedTaskId', store.activeTaskId);
  setStore('sidebarFocusedProjectId', null);
  triggerFocus('sidebar');
}

export function unfocusSidebar(): void {
  setStore('sidebarFocused', false);
  setStore('sidebarFocusedProjectId', null);
  setStore('sidebarFocusedTaskId', null);
}

export function focusPlaceholder(button?: 'add-task' | 'add-terminal'): void {
  setStore('placeholderFocused', true);
  setStore('sidebarFocused', false);
  if (button) setStore('placeholderFocusedButton', button);
}

export function unfocusPlaceholder(): void {
  setStore('placeholderFocused', false);
}

export function setSidebarFocusedProjectId(id: string | null): void {
  setStore('sidebarFocusedProjectId', id);
}

function focusTaskPanel(taskId: string, panel: string): void {
  batch(() => {
    setStore('focusedPanel', taskId, panel);
    setStore('sidebarFocused', false);
    setStore('placeholderFocused', false);
    setActiveTask(taskId);
  });
  triggerFocus(`${taskId}:${panel}`);
}

export function navigateRow(direction: 'up' | 'down'): void {
  if (store.showNewTaskDialog || store.showHelpDialog || store.showSettingsDialog) return;

  if (store.placeholderFocused) {
    if (direction === 'up') {
      setStore('placeholderFocusedButton', 'add-task');
    } else {
      setStore('placeholderFocusedButton', 'add-terminal');
    }
    return;
  }

  if (store.sidebarFocused) {
    const { taskOrder, projects, sidebarFocusedProjectId, sidebarFocusedTaskId } = store;

    if (sidebarFocusedProjectId !== null) {
      // Project mode: navigate within projects
      const projectIdx = projects.findIndex((p) => p.id === sidebarFocusedProjectId);
      if (direction === 'up') {
        if (projectIdx > 0) {
          setStore('sidebarFocusedProjectId', projects[projectIdx - 1].id);
        }
        // At first project: stay put
      } else {
        if (projectIdx < projects.length - 1) {
          setStore('sidebarFocusedProjectId', projects[projectIdx + 1].id);
        } else if (taskOrder.length > 0) {
          // Past last project: enter task mode
          setStore('sidebarFocusedProjectId', null);
          setStore('sidebarFocusedTaskId', taskOrder[0]);
        }
      }
      return;
    }

    // Task mode: navigate within tasks (highlight only, don't activate)
    if (taskOrder.length === 0 && projects.length === 0) return;
    const currentIdx = sidebarFocusedTaskId ? taskOrder.indexOf(sidebarFocusedTaskId) : -1;
    if (direction === 'up') {
      if (currentIdx <= 0 && projects.length > 0) {
        // At first task (or no task): enter project mode at last project
        setStore('sidebarFocusedTaskId', null);
        setStore('sidebarFocusedProjectId', projects[projects.length - 1].id);
      } else if (currentIdx > 0) {
        setStore('sidebarFocusedTaskId', taskOrder[currentIdx - 1]);
      }
    } else {
      if (taskOrder.length === 0) return;
      const nextIdx = Math.min(taskOrder.length - 1, currentIdx + 1);
      setStore('sidebarFocusedTaskId', taskOrder[nextIdx]);
    }
    return;
  }

  const taskId = store.activeTaskId;
  if (!taskId) return;

  const grid = buildGrid(taskId);
  const current = getTaskFocusedPanel(taskId);
  const pos = findInGrid(grid, current);
  if (!pos) return;

  const nextRow = direction === 'up' ? pos.row - 1 : pos.row + 1;
  if (nextRow < 0 || nextRow >= grid.length) return;

  // Clamp column to target row width
  const col = Math.min(pos.col, grid[nextRow].length - 1);
  setTaskFocusedPanel(taskId, grid[nextRow][col]);
}

export function navigateColumn(direction: 'left' | 'right'): void {
  if (store.showNewTaskDialog || store.showHelpDialog || store.showSettingsDialog) return;

  const taskId = store.activeTaskId;

  // From placeholder
  if (store.placeholderFocused) {
    if (direction === 'left') {
      unfocusPlaceholder();
      const lastTaskId = store.taskOrder[store.taskOrder.length - 1];
      if (lastTaskId) {
        setActiveTask(lastTaskId);
        setTaskFocusedPanel(lastTaskId, getTaskFocusedPanel(lastTaskId));
      } else if (store.sidebarVisible) {
        focusSidebar();
      }
    }
    return;
  }

  // From sidebar
  if (store.sidebarFocused) {
    if (direction === 'right') {
      const targetTaskId = store.sidebarFocusedTaskId ?? taskId;
      if (targetTaskId) {
        if (targetTaskId !== store.activeTaskId) setActiveTask(targetTaskId);
        unfocusSidebar();
        setTaskFocusedPanel(targetTaskId, getTaskFocusedPanel(targetTaskId));
      }
    }
    return;
  }

  if (!taskId) return;

  const grid = buildGrid(taskId);
  const current = getTaskFocusedPanel(taskId);
  const pos = findInGrid(grid, current);
  if (!pos) return;

  const row = grid[pos.row];
  const nextCol = direction === 'left' ? pos.col - 1 : pos.col + 1;

  // Within-row movement
  if (nextCol >= 0 && nextCol < row.length) {
    setTaskFocusedPanel(taskId, row[nextCol]);
    return;
  }

  // Cross task boundary
  const { taskOrder } = store;
  const taskIdx = taskOrder.indexOf(taskId);

  if (direction === 'left') {
    if (taskIdx === 0) {
      if (store.sidebarVisible) focusSidebar();
      return;
    }
    const prevTaskId = taskOrder[taskIdx - 1];
    if (prevTaskId) {
      if (!store.tasks[prevTaskId]) {
        focusTaskPanel(prevTaskId, defaultPanelFor(prevTaskId));
      } else {
        const prevGrid = buildGrid(prevTaskId);
        const prevPos = findInGrid(prevGrid, current);
        const targetRow = prevPos ? prevPos.row : pos.row;
        const safeRow = Math.min(targetRow, prevGrid.length - 1);
        const lastCol = prevGrid[safeRow].length - 1;
        focusTaskPanel(prevTaskId, prevGrid[safeRow][lastCol]);
      }
    }
  } else {
    const nextTaskId = taskOrder[taskIdx + 1];
    if (nextTaskId) {
      if (!store.tasks[nextTaskId]) {
        focusTaskPanel(nextTaskId, defaultPanelFor(nextTaskId));
      } else {
        const nextGrid = buildGrid(nextTaskId);
        const nextPos = findInGrid(nextGrid, current);
        const targetRow = nextPos ? nextPos.row : pos.row;
        const safeRow = Math.min(targetRow, nextGrid.length - 1);
        focusTaskPanel(nextTaskId, nextGrid[safeRow][0]);
      }
    } else {
      // Past last task: focus placeholder
      focusPlaceholder('add-task');
    }
  }
}

export function setPendingAction(
  action: { type: 'close' | 'merge' | 'push'; taskId: string } | null,
): void {
  setStore('pendingAction', action);
}

export function clearPendingAction(): void {
  setStore('pendingAction', null);
}

export function toggleHelpDialog(show?: boolean): void {
  setStore('showHelpDialog', show ?? !store.showHelpDialog);
}

export function toggleSettingsDialog(show?: boolean): void {
  setStore('showSettingsDialog', show ?? !store.showSettingsDialog);
}

export function sendActivePrompt(): void {
  const taskId = store.activeTaskId;
  if (!taskId) return;
  triggerAction(`${taskId}:send-prompt`);
}
