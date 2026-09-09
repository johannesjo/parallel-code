import { IPC } from '../../electron/ipc/channels';
import { isAgentHookEventPayload } from '../../electron/agent-hooks/status';
import { invoke } from '../lib/ipc';
import { isPlanApprovalEvent, nextCanvasOpen } from '../lib/canvas-auto-open';
import { canvasTabKey, isTaskCanvasVisible, withTab, withoutTab } from '../lib/canvas-tabs';
import {
  CANVAS_MIN_WIDTH,
  TASK_TILE_DEFAULT_WIDTH,
  TASK_TILE_MIN_WIDTH,
} from '../lib/layout-sizes';
import { store, setStore } from './core';
import { saveState } from './persistence';
import { getPanelUserSize, setPanelUserSize } from './ui';
import type { CanvasTab, Task } from './types';

type CanvasState = Pick<Task, 'canvasOpen' | 'canvasTabs' | 'canvasActiveTab'>;

export { isTaskCanvasVisible } from '../lib/canvas-tabs';

/** The width the canvas column takes: the size the user dragged it to, else its minimum. */
function canvasWidth(taskId: string): number {
  return getPanelUserSize(`task:${taskId}:canvas-cols:canvas`) ?? CANVAS_MIN_WIDTH;
}

/** The task column grows by the canvas when it opens and gives the space back
 *  when it closes, so the task body keeps its width either way. */
function resizeTaskColumnForCanvas(taskId: string, direction: 1 | -1): void {
  const key = `tiling:${taskId}`;
  const width = getPanelUserSize(key) ?? TASK_TILE_DEFAULT_WIDTH;
  const next = width + direction * canvasWidth(taskId);
  setPanelUserSize(key, Math.max(TASK_TILE_MIN_WIDTH, next));
}

/** Applies a canvas change, resizing the column when it appears or goes. */
function updateCanvas(taskId: string, next: CanvasState): void {
  const task = store.tasks[taskId];
  if (!task) return;
  const was = isTaskCanvasVisible(task);
  const will = isTaskCanvasVisible(next);
  if (will && !was) resizeTaskColumnForCanvas(taskId, 1);
  if (was && !will) resizeTaskColumnForCanvas(taskId, -1);
  setStore('tasks', taskId, next);
}

/** Puts a Markdown file of the worktree in front on the task's canvas, in its
 *  own tab unless one shows it already. */
export function openCanvasDocument(taskId: string, path: string): void {
  const task = store.tasks[taskId];
  if (!task) return;
  const tab: CanvasTab = { kind: 'markdown', path };
  updateCanvas(taskId, {
    canvasTabs: withTab(task.canvasTabs ?? [], tab),
    canvasActiveTab: canvasTabKey(tab),
    canvasOpen: true,
  });
  void saveState();
}

export function activateCanvasTab(taskId: string, key: string): void {
  const task = store.tasks[taskId];
  if (!task?.canvasTabs?.some((t) => canvasTabKey(t) === key)) return;
  setStore('tasks', taskId, 'canvasActiveTab', key);
  void saveState();
}

/** Closes one tab; closing the last one closes the column. */
export function closeCanvasTab(taskId: string, key: string): void {
  const task = store.tasks[taskId];
  if (!task) return;
  const next = withoutTab(task.canvasTabs ?? [], task.canvasActiveTab, key);
  if (next.tabs.length === 0) {
    closeTaskCanvas(taskId);
    return;
  }
  updateCanvas(taskId, { canvasTabs: next.tabs, canvasActiveTab: next.active });
  void saveState();
}

/** Shows the column; with nothing open it offers the picker. Not persisted. */
export function openTaskCanvas(taskId: string): void {
  updateCanvas(taskId, { canvasOpen: true });
}

/** Hides the column and forgets every tab. */
export function closeTaskCanvas(taskId: string): void {
  if (!store.tasks[taskId]) return;
  updateCanvas(taskId, {
    canvasTabs: undefined,
    canvasActiveTab: undefined,
    canvasOpen: undefined,
  });
  void saveState();
}

/** A newly detected plan opens on the canvas for every agent. Repeated file
 * events leave the user's choice of open or closed canvas alone. */
export function openArrivedPlan(taskId: string, previousPlanPath: string | undefined): void {
  const task = store.tasks[taskId];
  const planPath = task?.planPath;
  if (!task || !planPath || planPath === previousPlanPath) return;
  openCanvasDocument(taskId, planPath);
}

/** Puts the task's newest plan on the canvas; the plan watcher may not have
 *  reported it yet, so it is looked up rather than read from the store. */
async function openNewestPlan(task: Task): Promise<void> {
  const plan = await invoke<{ relativePath?: string } | null>(IPC.ReadPlanContent, {
    worktreePath: task.worktreePath,
  });
  if (plan?.relativePath && store.tasks[task.id]) openCanvasDocument(task.id, plan.relativePath);
}

/**
 * Puts the Markdown file an agent just wrote on its task's canvas, when
 * nothing is open there. Tabs the user has stay; they can switch by hand.
 * A plan waiting for approval always opens: that is what the canvas is for.
 * Returns the unsubscribe.
 */
export function startCanvasAutoOpen(): () => void {
  const pending = new Map<string, string>();
  return window.electron.ipcRenderer.on(IPC.AgentHookEvent, (data: unknown) => {
    if (!isAgentHookEventPayload(data)) return;
    const task = store.tasks[data.taskId];
    if (!task?.worktreePath) return;
    if (isPlanApprovalEvent(data)) {
      void openNewestPlan(task).catch((e) => console.warn('[canvas] plan did not open:', e));
      return;
    }
    const opened = nextCanvasOpen(pending, data, task.worktreePath);
    if (opened && !task.canvasTabs?.length) openCanvasDocument(task.id, opened);
  });
}
