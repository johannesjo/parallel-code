import { store } from '../store/core';
import { isAiTerminalPanel } from '../store/focused-panel';
import { boardShown } from '../store/project-pages';
import { samePanelKindIn } from '../store/store';
import type { Task } from '../store/types';
import { askingPanel, openTask } from './board/task-state';
import { openBeside } from './board/TaskStatus';
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
 * The task `step` places from the current one, wrapping around; when the
 * current one is not waiting, the first going forward or the last going back.
 * An answered task leaves the queue, so the next press starts again from the
 * most urgent.
 */
function stepInQueue(queue: Task[], currentId: string | null, step: 1 | -1): Task | undefined {
  const at = queue.findIndex((task) => task.id === currentId);
  const from = at === -1 && step === -1 ? 0 : at;
  const next = queue[(from + step + queue.length) % queue.length];
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

function openAttentionTask(step: 1 | -1): void {
  const task = stepInQueue(attentionQueue(), store.activeTaskId, step);
  if (!task) return;
  const panel = landingPanel(task.id);
  if (boardShown()) openBeside(task, false, panel);
  else openTask(task, panel);
}

/** Opens the next waiting task, beside the board while it is shown. */
export function openNextAttentionTask(): void {
  openAttentionTask(1);
}

/** Opens the previous waiting task, beside the board while it is shown. */
export function openPreviousAttentionTask(): void {
  openAttentionTask(-1);
}
