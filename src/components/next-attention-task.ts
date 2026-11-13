import { store } from '../store/core';
import { isAiTerminalPanel } from '../store/focused-panel';
import { boardShown } from '../store/project-pages';
import { previousTaskId } from '../store/previous-task';
import { samePanelKindIn } from '../store/store';
import type { Task } from '../store/types';
import { askingPanel, openTask } from './board/task-state';
import { openBesideBoard } from './board/TaskStatus';
import { forgetWorkingHolds } from './task-board-hold';
import { boardLanes, boardTasks } from './task-board-lanes';

/**
 * Tasks waiting on you, in board order: Needs you, then Stopped. Tasks being
 * closed sit in Stopped but are already on their way out.
 */
function attentionQueue(): Task[] {
  const lanes = boardLanes(boardTasks(''));
  // Reading lanes records who is working, for the board's hold. With the board
  // closed nothing would clear that, and a task that stops later would be held
  // in Working and skipped here.
  if (!boardShown()) forgetWorkingHolds();
  return ['needs', 'stopped']
    .flatMap((id) => lanes.find((lane) => lane.id === id)?.tasks ?? [])
    .filter((task) => task.closingStatus !== 'closing' && task.closingStatus !== 'removing');
}

/**
 * The task after the current one, wrapping around; when the current one is not
 * waiting, the first. An answered task leaves the queue, so the next press
 * starts again from the most urgent.
 */
function nextInQueue(queue: Task[], currentId: string | null): Task | undefined {
  const next = queue[(queue.findIndex((task) => task.id === currentId) + 1) % queue.length];
  return next?.id === currentId ? undefined : next;
}

/**
 * The pane to land on: the kind the keyboard is in now, so cycling does not
 * pull it elsewhere; among agent terminals, the one that asks.
 */
function landingPanel(taskId: string): string | null {
  const asking = askingPanel(taskId);
  const same = samePanelKindIn(taskId);
  if (same && isAiTerminalPanel(same) && asking && isAiTerminalPanel(asking)) return asking;
  return same ?? asking;
}

function openBesideBoardOrInLayout(task: Task, panel: string | null): void {
  if (!boardShown()) {
    // The layout scrolls the active task into view itself.
    openTask(task, panel);
    return;
  }
  openBesideBoard(task.id, () => {
    openTask(task, panel);
    // After the batch has opened the side panel, which narrows the board, and
    // inside a view transition's update so the new snapshot shows the card.
    queueMicrotask(() => revealBoardCard(task.id));
  });
}

/**
 * Scrolls the board so the task's card is on screen; the board does not follow
 * the side panel on its own. Not `focus()`: the keyboard stays in the pane.
 */
function revealBoardCard(taskId: string): void {
  document
    .querySelector(`[data-board-task-id="${CSS.escape(taskId)}"]`)
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
}

/** Opens the next waiting task, beside the board while it is shown. */
export function openNextAttentionTask(): void {
  const task = nextInQueue(attentionQueue(), store.activeTaskId);
  if (task) openBesideBoardOrInLayout(task, landingPanel(task.id));
}

/**
 * Goes back to the task that was active before this one, beside the board
 * while it is shown, on the pane it was left on. Closing, snoozed and
 * minimized tasks are skipped: opening one would wake it or restart its agents.
 */
export function openPreviousTask(): void {
  const id = previousTaskId();
  const task = id ? store.tasks[id] : undefined;
  if (!task || task.closingStatus === 'closing' || task.closingStatus === 'removing') return;
  if (task.collapsed || task.snoozedUntilCi || task.snoozedUntil !== undefined) return;
  openBesideBoardOrInLayout(task, null);
}
