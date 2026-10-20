/** Width of a task's column in the tiling strip. The column holds the task body
 *  and, when it is open, the canvas beside it — so whatever appears inside has
 *  to be paid for here, or it takes the space from what was already there. */

import {
  AGENT_PANE_MIN_WIDTH,
  CANVAS_DEFAULT_WIDTH,
  TASK_TILE_DEFAULT_WIDTH,
  TASK_TILE_MIN_WIDTH,
} from '../lib/layout-sizes';
import { isTaskCanvasVisible } from '../lib/canvas-tabs';
import { store } from './core';
import { getPanelUserSize, setPanelUserSize } from './ui';

const columnKey = (taskId: string): string => `tiling:${taskId}`;

const columnWidth = (taskId: string): number =>
  getPanelUserSize(columnKey(taskId)) ?? TASK_TILE_DEFAULT_WIDTH;

/** The width the canvas column takes: the size the user dragged it to, else its minimum. */
function canvasWidth(taskId: string): number {
  return getPanelUserSize(`task:${taskId}:canvas-cols:canvas`) ?? CANVAS_DEFAULT_WIDTH;
}

/** The task column grows by the canvas when it opens and gives the space back
 *  when it closes, so the task body keeps its width either way. */
export function resizeTaskColumnForCanvas(taskId: string, direction: 1 | -1): void {
  const next = columnWidth(taskId) + direction * canvasWidth(taskId);
  setPanelUserSize(columnKey(taskId), Math.max(TASK_TILE_MIN_WIDTH, next));
}

/**
 * Widens the column so each of the task's AI terminal panes clears
 * `AGENT_PANE_MIN_WIDTH`, because a second pane otherwise halves the first one.
 * Grows only: a column the user already made wide enough is left alone, and
 * closing a pane leaves the extra width for them to reclaim by hand.
 */
export function widenTaskColumnForAgentPanes(taskId: string): void {
  const task = store.tasks[taskId];
  // Tabs stack the panes on top of each other, so they share one pane's width.
  if (!task || task.aiTerminalLayout === 'tabs') return;
  const width = columnWidth(taskId);
  const body = width - (isTaskCanvasVisible(task) ? canvasWidth(taskId) : 0);
  const needed = task.agentIds.length * AGENT_PANE_MIN_WIDTH;
  if (body >= needed) return;
  setPanelUserSize(columnKey(taskId), width + (needed - body));
}
