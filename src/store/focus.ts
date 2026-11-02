import { isDocumentAgentTaskId } from '../documents/task-id';
import { batch } from 'solid-js';
import { store, setStore } from './core';
import { openPanelOrder, setActiveTask } from './navigation';
import { showNotification } from './notification';
import { computeSidebarTaskOrder } from './sidebar-order';
import { isTaskBackgrounded } from './background-tasks';
import { uncollapseTask } from './tasks';
import { isTaskCanvasVisible } from '../lib/canvas-tabs';
import { boardShown, boardSidePanelOpen, towardBoard } from './project-pages';
import type { PendingAction } from './types';
import { getTaskShellLayout } from './shell-layout';
import { shellColumns } from '../lib/shellLayout';
import {
  AI_TERMINAL_PANEL,
  aiTerminalPanels,
  defaultPanelFor,
  getTaskFocusedPanel,
  isAiTerminalPanel,
  isShellPanel,
  setTaskFocusedPanel,
  shellPanelId,
  shellPanelIndex,
  triggerFocus,
} from './focused-panel';

// Re-export panel/focus-registry helpers from their new home so existing
// importers of './focus' keep working without a cycle through focused-panel.
export {
  AI_TERMINAL_PANEL,
  aiTerminalPanelId,
  aiTerminalPanels,
  defaultPanelFor,
  getTaskFocusedPanel,
  isAiTerminalPanel,
  registerFocusFn,
  scrollTaskElementIntoView,
  setTaskFocusedPanel,
  shellPanelId,
  triggerFocus,
  unregisterFocusFn,
} from './focused-panel';
export { isPanelFocused, isPanelFocusedOrDefault, isPanelFocusedPrefix } from './focused-panel';

const actionRegistry = new Map<string, () => void>();

export function registerAction(key: string, fn: () => void): void {
  actionRegistry.set(key, fn);
}

/** Pass the registered `fn` so a component leaving a key does not delete the registration
 *  a replacement has already made under it. */
export function unregisterAction(key: string, fn?: () => void): void {
  if (!fn || actionRegistry.get(key) === fn) actionRegistry.delete(key);
}

export function triggerAction(key: string): void {
  actionRegistry.get(key)?.();
}

// Grid-based spatial navigation. Two task layouts:
//  - vertical stack (default): everything in one column
//  - split (focus mode, panel wide enough): ai-terminal panes/prompt anchor the
//    left, changed-files/notes/shell anchor the right, and AI panes are
//    repeated down the left columns so left/right crossings stay consistent.

const SHELL_TOOLBAR_PANEL_PREFIX = 'shell-toolbar:';

function shellToolbarPanels(task: { projectId: string }): string[] {
  const bookmarkCount =
    store.projects.find((p) => p.id === task.projectId)?.terminalBookmarks?.length ?? 0;
  return Array.from({ length: 1 + bookmarkCount }, (_, i) => `${SHELL_TOOLBAR_PANEL_PREFIX}${i}`);
}

function isShellToolbarPanel(panel: string): boolean {
  return panel.startsWith(SHELL_TOOLBAR_PANEL_PREFIX);
}

function edgeIndex(count: number, entryEdge: 'left' | 'right'): number {
  return entryEdge === 'right' ? 0 : count - 1;
}

function pickTargetTerminalFamilyPanel(
  current: string,
  targetTask: { shellAgentIds: string[]; projectId: string },
  entryEdge: 'left' | 'right',
): string | null {
  if (isAiTerminalPanel(current)) return AI_TERMINAL_PANEL;

  if (isShellPanel(current)) {
    if (targetTask.shellAgentIds.length > 0) {
      return shellPanelId(edgeIndex(targetTask.shellAgentIds.length, entryEdge));
    }

    const toolbarPanels = shellToolbarPanels(targetTask);
    return toolbarPanels[edgeIndex(toolbarPanels.length, entryEdge)] ?? null;
  }

  if (isShellToolbarPanel(current)) {
    const toolbarPanels = shellToolbarPanels(targetTask);
    return toolbarPanels[edgeIndex(toolbarPanels.length, entryEdge)] ?? null;
  }

  return null;
}

/** Cells that belong to the left column in split mode. */
function isLeftColumnPanel(panel: string): boolean {
  return (
    panel === 'title' || panel === 'prompt' || panel === 'terminal' || isAiTerminalPanel(panel)
  );
}

/** Shell panel ids split into the visual rows of the task's shell layout. */
function shellRows(taskId: string, shellCount: number): string[][] {
  const cols = shellColumns(getTaskShellLayout(taskId), shellCount);
  const rows: string[][] = [];
  for (let i = 0; i < shellCount; i += cols) {
    rows.push(
      Array.from({ length: Math.min(cols, shellCount - i) }, (_, j) => shellPanelId(i + j)),
    );
  }
  return rows;
}

function buildGrid(panelId: string): string[][] {
  const grid = buildMainGrid(panelId);
  const task = store.tasks[panelId];
  // The canvas spans the task body to the right of either main layout.
  return task && isTaskCanvasVisible(task)
    ? grid.map((row, index) => (index === 0 ? row : [...row, 'canvas']))
    : grid;
}

function buildMainGrid(panelId: string): string[][] {
  const task = store.tasks[panelId];
  if (task) {
    const toolbarCols = shellToolbarPanels(task);
    const aiCols = aiTerminalPanels(task);
    if (isDocumentAgentTaskId(panelId)) return [aiCols, ['prompt']];

    if (store.taskSplitMode[panelId]) {
      const grid: string[][] = [['title']];
      grid.push([...aiCols, 'changed-files']);
      grid.push([...aiCols, 'notes']);

      // Pair the bottom-left (prompt or first AI pane if prompt hidden) with
      // whatever's at the bottom-right, so → from prompt jumps into the shell
      // section instead of falling off to the next task. Left cells are padded
      // to the AI pane count so the right column keeps one column index.
      const leftBottom = store.showPromptInput ? 'prompt' : aiCols[0];
      const bottomCols = aiCols.map(() => leftBottom);
      const rows = shellRows(panelId, task.shellAgentIds.length);
      if (rows.length > 0) {
        grid.push([...aiCols, ...toolbarCols]);
        rows.forEach((row, i) => {
          grid.push([...(i === rows.length - 1 ? bottomCols : aiCols), ...row]);
        });
      } else {
        grid.push([...bottomCols, ...toolbarCols]);
      }
      return grid;
    }

    const grid: string[][] = [['title']];
    grid.push(['notes', 'changed-files']);
    grid.push(toolbarCols);
    grid.push(...shellRows(panelId, task.shellAgentIds.length));
    grid.push(aiCols);
    if (store.showPromptInput) {
      grid.push(['prompt']);
    }
    return grid;
  }

  // Terminal panel: just title + terminal
  return [['title'], ['terminal']];
}

/** In split mode, find the first focusable panel in the right column. */
function pickTopRightColumnTarget(grid: string[][]): string | null {
  for (const row of grid) {
    for (let c = 1; c < row.length; c++) {
      const cell = row[c];
      if (!isLeftColumnPanel(cell)) return cell;
    }
  }
  return null;
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

export function focusSidebar(): void {
  setStore('sidebarFocused', true);
  setStore('placeholderFocused', false);
  setStore('newTaskPanelFocused', false);
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
  setStore('newTaskPanelFocused', false);
  if (button) setStore('placeholderFocusedButton', button);
  const target = button ?? store.placeholderFocusedButton;
  triggerFocus(`placeholder:${target}`);
}

export function unfocusPlaceholder(): void {
  setStore('placeholderFocused', false);
}

/** Arrow-key travel order. It skips snoozed tiles: activating one ends its
 *  snooze, so passing through would undo the snooze. Sidebar clicks and Ctrl+N still reach them. */
function travelOrder(): string[] {
  return openPanelOrder().filter((id) => !isTaskBackgrounded(id));
}

function focusTaskPanel(taskId: string, panel: string): void {
  batch(() => {
    setActiveTask(taskId);
    setTaskFocusedPanel(taskId, panel);
  });
}

function focusNewTaskPanel(): void {
  unfocusSidebar();
  unfocusPlaceholder();
  setStore('newTaskPanelFocused', true);
  triggerFocus('new-task');
}

/**
 * Moves the keyboard onto the all-tasks board, to the active task's card. The
 * board clears the other focus flags once it has DOM focus, so a board that
 * cannot take it leaves them, and the keys, where they were.
 */
function focusBoard(): void {
  triggerFocus('task-board');
}

/** Moves the keyboard from the board into its side panel: the draft, or the task shown there. */
export function focusBoardSidePanel(): void {
  if (store.showNewTaskPanel) {
    focusNewTaskPanel();
    return;
  }
  const id = store.activeTaskId;
  if (id) setTaskFocusedPanel(id, getTaskFocusedPanel(id));
}

function navigateAiTerminalColumn(
  taskId: string,
  current: string,
  direction: 'left' | 'right',
): boolean {
  if (!isAiTerminalPanel(current)) return false;
  const task = store.tasks[taskId];
  if (!task) return false;

  const panels = aiTerminalPanels(task);
  const currentIdx = panels.indexOf(current);
  const step = direction === 'right' ? 1 : -1;
  const nextIdx = currentIdx + step;
  if (currentIdx !== -1 && nextIdx >= 0 && nextIdx < panels.length) {
    setTaskFocusedPanel(taskId, panels[nextIdx]);
    return true;
  }
  return false;
}

export function navigateRow(direction: 'up' | 'down'): void {
  if (store.showHelpDialog || store.showSettingsDialog) return;

  if (store.placeholderFocused) {
    const btn = direction === 'up' ? 'add-task' : 'add-terminal';
    setStore('placeholderFocusedButton', btn);
    triggerFocus(`placeholder:${btn}`);
    return;
  }

  if (store.sidebarFocused) {
    const { projects, sidebarFocusedProjectId, sidebarFocusedTaskId } = store;
    const allTasks = computeSidebarTaskOrder();
    // When the Projects section is collapsed, hidden items aren't a navigable
    // axis — ↑/↓ stays in task mode regardless of any leftover project focus.
    const projectsNavigable = !store.projectsCollapsed && projects.length > 0;

    if (projectsNavigable && sidebarFocusedProjectId !== null) {
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
    if (allTasks.length === 0 && !projectsNavigable) return;
    const currentIdx = sidebarFocusedTaskId ? allTasks.indexOf(sidebarFocusedTaskId) : -1;
    if (direction === 'up') {
      if (currentIdx <= 0 && projectsNavigable) {
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

  // The draft is a single tile with no panel rows of its own. Row keys are global, so
  // without this it would fall through and pull focus onto the background task's panels.
  if (store.showNewTaskPanel && store.newTaskPanelFocused) return;

  const taskId = store.activeTaskId;
  if (!taskId) return;

  const grid = buildMainGrid(taskId);
  let current = getTaskFocusedPanel(taskId);
  // The canvas is one full-height column, with only the title above it.
  const task = store.tasks[taskId];
  if (current === 'canvas' && task && isTaskCanvasVisible(task)) {
    if (direction === 'up') setTaskFocusedPanel(taskId, 'title');
    return;
  }
  let pos = findInGrid(grid, current);
  // The previously focused cell can vanish (shells killed,
  // width crossing threshold). Recover by falling back to the default instead of
  // leaving arrow keys silently broken until the user clicks.
  if (!pos) {
    const fallback = defaultPanelFor(taskId);
    pos = findInGrid(grid, fallback);
    if (!pos) return;
    setTaskFocusedPanel(taskId, fallback);
    current = fallback;
  }

  if (store.taskSplitMode[taskId]) {
    if (direction === 'down' && isAiTerminalPanel(current) && store.showPromptInput) {
      setTaskFocusedPanel(taskId, 'prompt');
      return;
    }
    if (direction === 'up' && current === 'prompt') {
      setTaskFocusedPanel(taskId, AI_TERMINAL_PANEL);
      return;
    }
  }

  const step = direction === 'up' ? -1 : 1;
  let nextRow = pos.row + step;
  // Skip rows whose clamped target equals the current cell — in split mode,
  // ai-terminal spans many rows on col 0, so ↓ from it has to walk past itself
  // to reach prompt (or the right column, below).
  while (nextRow >= 0 && nextRow < grid.length) {
    const col = Math.min(pos.col, grid[nextRow].length - 1);
    const target = grid[nextRow][col];
    if (target !== current) {
      setTaskFocusedPanel(taskId, target);
      return;
    }
    nextRow += step;
  }

  // Dead-end: in split mode, ↓ from ai-terminal when no prompt/shells anchor
  // the left column's bottom would otherwise stop — enter the top-right panel.
  if (
    direction === 'down' &&
    store.taskSplitMode[taskId] &&
    pos.col === 0 &&
    isAiTerminalPanel(current)
  ) {
    const target = pickTopRightColumnTarget(grid);
    if (target) setTaskFocusedPanel(taskId, target);
  }
}

export function navigateColumn(direction: 'left' | 'right'): void {
  if (store.showHelpDialog || store.showSettingsDialog) return;

  const taskId = store.activeTaskId;

  // The open draft is a real tile between the last task and the add controls.
  if (store.showNewTaskPanel && store.newTaskPanelFocused) {
    // Beside the board, the board is its only neighbour.
    if (boardSidePanelOpen()) {
      if (direction === towardBoard()) focusBoard();
      return;
    }
    if (direction === 'right') {
      // The add-task tile is only rendered beside a visible tile.
      if (travelOrder().length > 0) focusPlaceholder('add-task');
    } else {
      const lastTaskId = travelOrder().at(-1);
      if (lastTaskId) {
        focusTaskPanel(lastTaskId, getTaskFocusedPanel(lastTaskId));
      } else if (store.sidebarVisible) {
        focusSidebar();
      }
    }
    return;
  }

  // From placeholder
  if (store.placeholderFocused) {
    if (direction === 'left') {
      if (store.showNewTaskPanel) {
        focusNewTaskPanel();
        return;
      }
      unfocusPlaceholder();
      const lastTaskId = travelOrder().at(-1);
      if (lastTaskId) {
        setActiveTask(lastTaskId);
        setTaskFocusedPanel(lastTaskId, getTaskFocusedPanel(lastTaskId));
      } else if (store.sidebarVisible) {
        focusSidebar();
      }
    }
    return;
  }

  // From sidebar — always enter at the leftmost task panel, regardless of which
  // task is highlighted in the sidebar. The sidebar list is its own axis; → is
  // for crossing into the panel area, not for activating the highlighted item.
  if (store.sidebarFocused) {
    if (direction === 'right' && boardShown()) {
      // A side panel on the board's left is the sidebar's neighbour.
      if (boardSidePanelOpen() && store.boardSidePanelLeft) focusBoardSidePanel();
      else focusBoard();
      return;
    }
    if (direction === 'right') {
      const targetTaskId = travelOrder()[0] ?? store.sidebarFocusedTaskId ?? taskId;
      if (targetTaskId) {
        if (store.tasks[targetTaskId]?.collapsed) {
          uncollapseTask(targetTaskId);
          return;
        }
        if (targetTaskId !== store.activeTaskId) setActiveTask(targetTaskId);
        unfocusSidebar();
        setTaskFocusedPanel(targetTaskId, getTaskFocusedPanel(targetTaskId));
      } else if (store.showNewTaskPanel) {
        focusNewTaskPanel();
      }
    }
    return;
  }

  if (!taskId) return;

  const grid = buildGrid(taskId);
  let current = getTaskFocusedPanel(taskId);
  let pos = findInGrid(grid, current);
  if (!pos) {
    const fallback = defaultPanelFor(taskId);
    pos = findInGrid(grid, fallback);
    if (!pos) return;
    setTaskFocusedPanel(taskId, fallback);
    current = fallback;
  }

  if (navigateAiTerminalColumn(taskId, current, direction)) return;

  const row = grid[pos.row];
  const step = direction === 'left' ? -1 : 1;
  let nextCol = pos.col + step;
  // Split mode repeats the bottom-left cell across the AI pane columns.
  while (row[nextCol] === current) nextCol += step;
  if (nextCol >= 0 && nextCol < row.length) {
    setTaskFocusedPanel(taskId, row[nextCol]);
    return;
  }

  // The side panel holds one task; the board's keys decide where its edges lead.
  if (boardSidePanelOpen()) return;

  // Cross task boundary
  const taskOrder = travelOrder();
  const taskIdx = taskOrder.indexOf(taskId);
  const isCurrentTerminal = !store.tasks[taskId];

  const focusAdjacentTask = (targetId: string, entryEdge: 'left' | 'right') => {
    if (isCurrentTerminal && store.tasks[targetId]) {
      focusTaskPanel(targetId, getTaskFocusedPanel(targetId));
    } else if (!store.tasks[targetId]) {
      focusTaskPanel(targetId, defaultPanelFor(targetId));
    } else {
      const semanticTarget = pickTargetTerminalFamilyPanel(
        current,
        store.tasks[targetId],
        entryEdge,
      );
      if (semanticTarget) {
        focusTaskPanel(targetId, semanticTarget);
        return;
      }

      const targetGrid = buildGrid(targetId);
      const targetPos = findInGrid(targetGrid, current);
      const targetRow = targetPos ? targetPos.row : pos.row;
      const safeRow = Math.min(targetRow, targetGrid.length - 1);
      const col = entryEdge === 'right' ? 0 : targetGrid[safeRow].length - 1;
      const target = targetGrid[safeRow][col];
      focusTaskPanel(targetId, isAiTerminalPanel(target) ? AI_TERMINAL_PANEL : target);
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
    } else if (store.showNewTaskPanel) {
      focusNewTaskPanel();
    } else {
      focusPlaceholder('add-task');
    }
  }
}

/**
 * Switch directly to the prev/next task in `taskOrder`, preserving the focused
 * panel name when it exists in the target's grid. Clamps at edges (no sidebar
 * or placeholder fall-through). Collapsed tasks are not in `taskOrder`, and
 * snoozed ones are filtered out, so both are skipped — same semantics as
 * `navigateColumn`'s cross-task path. The board passes its own card order.
 */
export function navigateTask(
  direction: 'left' | 'right',
  taskOrder: string[] = travelOrder(),
): void {
  if (store.showHelpDialog || store.showSettingsDialog) return;

  const { activeTaskId } = store;

  if (store.showNewTaskPanel && store.newTaskPanelFocused) {
    if (direction === 'left') {
      const lastTaskId = taskOrder.at(-1);
      if (lastTaskId) focusTaskPanel(lastTaskId, getTaskFocusedPanel(lastTaskId));
    }
    return;
  }

  if (!activeTaskId) return;

  const currentIdx = taskOrder.indexOf(activeTaskId);
  if (currentIdx === -1) return;

  const targetIdx = direction === 'left' ? currentIdx - 1 : currentIdx + 1;
  if (targetIdx < 0) return;
  if (targetIdx >= taskOrder.length) {
    if (direction === 'right' && store.showNewTaskPanel) focusNewTaskPanel();
    return;
  }

  switchTaskKeepingPanel(taskOrder[targetIdx]);
}

/**
 * The target task's pane of the kind the keyboard is in now, or null when it
 * has none. Any agent terminal stands for another, as agents differ per task;
 * shells keep their position where the target has that many.
 */
export function samePanelKindIn(targetId: string): string | null {
  const { activeTaskId } = store;
  const target = store.tasks[targetId];
  if (!activeTaskId || !target) return null;
  const current = getTaskFocusedPanel(activeTaskId);
  if (isAiTerminalPanel(current)) return AI_TERMINAL_PANEL;
  if (isShellPanel(current)) {
    const shells = target.shellAgentIds.length;
    return shells > 0 ? shellPanelId(Math.min(shellPanelIndex(current) ?? 0, shells - 1)) : null;
  }
  return findInGrid(buildGrid(targetId), current) !== null ? current : null;
}

/** Activates a task with the keyboard on the pane of the same name, where it has one. */
export function switchTaskKeepingPanel(targetId: string): void {
  const { activeTaskId } = store;
  if (!store.tasks[targetId] || !activeTaskId) {
    setActiveTask(targetId);
    return;
  }

  const currentPanel = getTaskFocusedPanel(activeTaskId);
  const targetGrid = buildGrid(targetId);
  const targetPanel =
    findInGrid(targetGrid, currentPanel) !== null ? currentPanel : defaultPanelFor(targetId);

  batch(() => {
    setActiveTask(targetId);
    setTaskFocusedPanel(targetId, targetPanel);
  });
}

export function setPendingAction(action: PendingAction | null): void {
  if (action?.type === 'finish') {
    const task = store.tasks[action.taskId];
    if (task && task.gitIsolation !== 'worktree') {
      showNotification('Finish is only available for worktree tasks');
      return;
    }
  }

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
