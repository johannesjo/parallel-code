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
import type { Task } from './types';
import { getPanelUserSize, setPanelUserSize } from './ui';

const columnKey = (taskId: string): string => `tiling:${taskId}`;

/** The width the user dragged the column to, if they ever did. */
const pinnedWidth = (taskId: string): number | undefined => getPanelUserSize(columnKey(taskId));

/** The width the canvas column takes: the size the user dragged it to, else its minimum. */
function canvasWidth(taskId: string): number {
  return getPanelUserSize(`task:${taskId}:canvas-cols:canvas`) ?? CANVAS_DEFAULT_WIDTH;
}

/** Room the task body needs so each side-by-side AI terminal pane clears
 *  `AGENT_PANE_MIN_WIDTH`; a second pane would otherwise halve the first. */
function bodyWidthNeeded(task: Task): number {
  // Tabs stack the panes on top of each other, so they share one pane's width.
  const panes = task.aiTerminalLayout === 'tabs' ? 1 : task.agentIds.length;
  return panes * AGENT_PANE_MIN_WIDTH;
}

/**
 * Width of a column the user never dragged: the default, widened for
 * side-by-side agent panes, plus the canvas while it is open. Derived on every
 * read and never saved, so the column gives the room back when they close and
 * stays undragged, which keeps pinned widths a record of what the user chose.
 */
export function autoTaskColumnWidth(taskId: string): number {
  const task = store.tasks[taskId];
  if (!task) return TASK_TILE_DEFAULT_WIDTH;
  const body = Math.max(TASK_TILE_DEFAULT_WIDTH, bodyWidthNeeded(task));
  return body + (isTaskCanvasVisible(task) ? canvasWidth(taskId) : 0);
}

/** A dragged column grows by the canvas when it opens and gives the space back
 *  when it closes, so the task body keeps its width either way. Undragged
 *  columns follow `autoTaskColumnWidth` instead. */
export function resizeTaskColumnForCanvas(taskId: string, direction: 1 | -1): void {
  const width = pinnedWidth(taskId);
  if (width === undefined) return;
  const next = width + direction * canvasWidth(taskId);
  setPanelUserSize(columnKey(taskId), Math.max(TASK_TILE_MIN_WIDTH, next));
}

/**
 * Widens a dragged column so each of the task's AI terminal panes clears
 * `AGENT_PANE_MIN_WIDTH`. Grows only: a column the user already made wide
 * enough is left alone, and closing a pane leaves the extra width for them to
 * reclaim by hand. Undragged columns follow `autoTaskColumnWidth` instead.
 */
export function widenTaskColumnForAgentPanes(taskId: string): void {
  const task = store.tasks[taskId];
  const width = pinnedWidth(taskId);
  if (!task || width === undefined) return;
  const body = width - (isTaskCanvasVisible(task) ? canvasWidth(taskId) : 0);
  const needed = bodyWidthNeeded(task);
  if (body >= needed) return;
  setPanelUserSize(columnKey(taskId), width + (needed - body));
}
