import { createEffect, createRoot, onCleanup, untrack } from 'solid-js';
import { store } from './core';
import { NOTIFICATION_ERROR_MS, showNotification } from './notification';
import { getTaskDotStatus } from './taskStatus';
import {
  backgroundVerifyEnabled,
  cancelBackgroundVerify,
  runBackgroundVerify,
} from './verification';

/** How long a task must stay idle first: agents pause between tool calls. */
export const AUTO_BUILD_SETTLE_MS = 15_000;

// shortcut: one global queue, one run at a time — a per-project limit if
// machines with many cores want parallel background runs.
const queue: string[] = [];
let draining = false;

/** A failed background verify is worth a note; the title bar shows the rest. */
async function verifyInBackground(taskId: string): Promise<void> {
  const run = await runBackgroundVerify(taskId, () => getTaskDotStatus(taskId) !== 'busy');
  const task = store.tasks[taskId];
  // An `error` run (say, a missing worktree) is not the code failing.
  if (!task || (run?.status !== 'failed' && run?.status !== 'timed_out')) return;
  showNotification(`${task.name}: verify failed · open Finish to hand it to the agent`, {
    durationMs: NOTIFICATION_ERROR_MS,
  });
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let taskId = queue.shift(); taskId !== undefined; taskId = queue.shift()) {
      if (!backgroundVerifyEnabled(taskId) || getTaskDotStatus(taskId) === 'busy') continue;
      try {
        await verifyInBackground(taskId);
      } catch (err) {
        console.error('Background check failed:', err);
      }
    }
  } finally {
    draining = false;
  }
}

function queueBuild(taskId: string): void {
  if (!queue.includes(taskId)) queue.push(taskId);
  void drain();
}

/**
 * Runs the verify command in the background once an agent's turn ends, unless
 * the project turned that off. It skips commits it already covered.
 */
export function startBackgroundChecks(): () => void {
  return createRoot((dispose) => {
    const wasBusy = new Map<string, boolean>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const cancel = (taskId: string) => {
      // Its result would describe a tree the agent is about to change.
      untrack(() => void cancelBackgroundVerify(taskId));
      clearTimeout(timers.get(taskId));
      timers.delete(taskId);
      const queued = queue.indexOf(taskId);
      if (queued >= 0) queue.splice(queued, 1);
    };
    createEffect(() => {
      for (const taskId of Object.keys(store.tasks)) {
        const busy = getTaskDotStatus(taskId) === 'busy';
        if (busy) cancel(taskId);
        else if (wasBusy.get(taskId)) {
          cancel(taskId);
          timers.set(
            taskId,
            setTimeout(() => {
              timers.delete(taskId);
              queueBuild(taskId);
            }, AUTO_BUILD_SETTLE_MS),
          );
        }
        wasBusy.set(taskId, busy);
      }
    });
    onCleanup(() => {
      for (const taskId of [...timers.keys()]) cancel(taskId);
      queue.length = 0;
    });
    return dispose;
  });
}
