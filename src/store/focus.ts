import { batch } from 'solid-js';
import { store, setStore } from './core';
import { setActiveTask } from './navigation';
import { computeSidebarTaskOrder } from './sidebar-order';
import { uncollapseTask } from './tasks';

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
// row 0: title
// row 1: notes           changed-files
// row 2: shell-toolbar:0   shell-toolbar:1  ...   (always present, one per button)
// row 3: shell:0         shell:1       shell:2   (only if shells exist)
// row 4: ai-terminal
// row 5: steps                                    (only if steps enabled)
// row 6: prompt

function buildGrid(panelId: string): string[][] {
  const task = store.tasks[panelId];
  if (task) {
    const bookmarkCount =
      store.projects.find((p) => p.id === task.projectId)?.terminalBookmarks?.length ?? 0;
    const toolbarCols = Array.from({ length: 1 + bookmarkCount }, (_, i) => `shell-toolbar:${i}`);
    const grid: string[][] = [['title']];
    grid.push(['notes', 'changed-files']);
    grid.push(toolbarCols);
    if (task.shellAgentIds.length > 0) {
      grid.push(task.shellAgentIds.map((_, i) => `shell:${i}`));
    }
    grid.push(['ai-terminal']);
    if (task.stepsEnabled && task.stepsContent?.length) {
      grid.push(['steps']);
    }
    if (store.showPromptInput) {
      grid.push(['prompt']);
    }
    return grid;
  }

  // Terminal panel: just title + terminal
  return [['title'], ['terminal']];
}

/** The panel to focus when navigating into a task or terminal. */
function defaultPanelFor(panelId: string): string {
  return store.tasks[panelId] ? 'ai-terminal' : 'terminal';
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
    const el = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
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
  const target = button ?? store.placeholderFocusedButton;
  triggerFocus(`placeholder:${target}`);
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
    const btn = direction === 'up' ? 'add-task' : 'add-terminal';
    setStore('placeholderFocusedButton', btn);
    triggerFocus(`placeholder:${btn}`);
    return;
  }

  if (store.sidebarFocused) {
    const { projects, sidebarFocusedProjectId, sidebarFocusedTaskId } = store;
    const allTasks = computeSidebarTaskOrder();

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
        } else if (allTasks.length > 0) {
          // Past last project: enter task mode
          setStore('sidebarFocusedProjectId', null);
          setStore('sidebarFocusedTaskId', allTasks[0]);
        }
      }
      return;
    }

    // Task mode: navigate within tasks (highlight only, don't activate)
    if (allTasks.length === 0 && projects.length === 0) return;
    const currentIdx = sidebarFocusedTaskId ? allTasks.indexOf(sidebarFocusedTaskId) : -1;
    if (direction === 'up') {
      if (currentIdx <= 0 && projects.length > 0) {
        // At first task (or no task): enter project mode at last project
        setStore('sidebarFocusedTaskId', null);
        setStore('sidebarFocusedProjectId', projects[projects.length - 1].id);
      } else if (currentIdx > 0) {
        setStore('sidebarFocusedTaskId', allTasks[currentIdx - 1]);
      }
    } else {
      if (allTasks.length === 0) return;
      const nextIdx = Math.min(allTasks.length - 1, currentIdx + 1);
      setStore('sidebarFocusedTaskId', allTasks[nextIdx]);
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
        // If the focused task is collapsed, uncollapse it instead of navigating into it
        if (store.tasks[targetTaskId]?.collapsed) {
          uncollapseTask(targetTaskId);
          return;
        }
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
  const isCurrentTerminal = !store.tasks[taskId];

  const focusAdjacentTask = (targetId: string, entryEdge: 'left' | 'right') => {
    if (isCurrentTerminal && store.tasks[targetId]) {
      focusTaskPanel(targetId, getTaskFocusedPanel(targetId));
    } else if (!store.tasks[targetId]) {
      focusTaskPanel(targetId, defaultPanelFor(targetId));
    } else {
      const targetGrid = buildGrid(targetId);
      const targetPos = findInGrid(targetGrid, current);
      const targetRow = targetPos ? targetPos.row : pos.row;
      const safeRow = Math.min(targetRow, targetGrid.length - 1);
      const col = entryEdge === 'right' ? 0 : targetGrid[safeRow].length - 1;
      focusTaskPanel(targetId, targetGrid[safeRow][col]);
    }
  };

  if (direction === 'left') {
    if (taskIdx === 0) {
      if (store.sidebarVisible) focusSidebar();
      return;
    }
    const prevTaskId = taskOrder[taskIdx - 1];
    if (prevTaskId) focusAdjacentTask(prevTaskId, 'left');
  } else {
    const nextTaskId = taskOrder[taskIdx + 1];
    if (nextTaskId) {
      focusAdjacentTask(nextTaskId, 'right');
    } else {
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
