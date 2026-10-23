import { createEffect, createRoot, onCleanup, untrack } from 'solid-js';
import { computeEvidenceConfidence } from '../../electron/shared/evidence-confidence';
import { EVIDENCE_LEVEL } from '../lib/evidence-display';
import { store } from './core';
import { buildEvidence } from './evidence';
import { isLandedTaskState } from './landing';
import { NOTIFICATION_ERROR_MS, showNotification } from './notification';
import { getProject } from './projects';
import { getTaskDotStatus } from './taskStatus';
import {
  backgroundVerifyEnabled,
  cancelBackgroundVerify,
  runBackgroundVerify,
} from './verification';

/** How long a task must stay idle first: agents pause between tool calls. */
export const AUTO_BUILD_SETTLE_MS = 15_000;

const FAILED = new Set(['failed', 'timed_out', 'error']);

// shortcut: one global queue, one build at a time — a per-project limit if
// machines with many cores want parallel background builds.
const queue: string[] = [];
let draining = false;

function autoBuildEnabled(taskId: string): boolean {
  const task = store.tasks[taskId];
  return Boolean(
    task &&
    task.gitIsolation === 'worktree' &&
    !isLandedTaskState(task.landingState) &&
    getProject(task.projectId)?.evidenceAutoBuild,
  );
}

/** A full evidence build, which runs verify first, or verify on its own. */
function backgroundWork(taskId: string): 'evidence' | 'verify' | undefined {
  if (autoBuildEnabled(taskId)) return 'evidence';
  return backgroundVerifyEnabled(taskId) ? 'verify' : undefined;
}

/** A failed background verify is worth a note; the title bar shows the rest. */
async function verifyInBackground(taskId: string): Promise<void> {
  const run = await runBackgroundVerify(taskId);
  const task = store.tasks[taskId];
  if (!task || !run || !FAILED.has(run.status)) return;
  showNotification(`${task.name}: verify failed · open Finish to hand it to the agent`, {
    durationMs: NOTIFICATION_ERROR_MS,
  });
}

/**
 * Speaks up only when the background build it just made found a failing check
 * or a weakened test. "Nothing ran" is routine here (no checks, or all held
 * back), and a note after every turn would teach people to ignore it.
 */
function reportProblems(taskId: string, previousId: string | undefined): void {
  const task = store.tasks[taskId];
  const pkg = task?.evidence;
  if (!task || !pkg || pkg.id === previousId || pkg.trigger !== 'auto') return;
  const failed = pkg.checks.some((run) => FAILED.has(run.status));
  const weakened = pkg.scan.flags.some(
    (flag) => flag.category === 'test-weakened' && !(flag.id in pkg.acceptedFlags),
  );
  if (!failed && !weakened) return;
  const confidence = computeEvidenceConfidence(pkg, pkg.scan.headSha);
  const reason = confidence.reasons[0]?.text;
  showNotification(
    `${task.name}: ${EVIDENCE_LEVEL[confidence.level].label}${reason ? ` · ${reason}` : ''}`,
    { durationMs: NOTIFICATION_ERROR_MS },
  );
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let taskId = queue.shift(); taskId !== undefined; taskId = queue.shift()) {
      const work = backgroundWork(taskId);
      if (!work || getTaskDotStatus(taskId) === 'busy') continue;
      const previousId = store.tasks[taskId]?.evidence?.id;
      try {
        if (work === 'verify') await verifyInBackground(taskId);
        else {
          await buildEvidence(taskId, { trigger: 'auto' });
          reportProblems(taskId, previousId);
        }
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
 * Checks each task in the background once an agent's turn ends: a full
 * evidence build for projects that turned it on, otherwise the verify command
 * unless the project turned that off. Both skip commits they already covered.
 */
export function startBackgroundChecks(): () => void {
  return createRoot((dispose) => {
    const wasBusy = new Map<string, boolean>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const cancel = (taskId: string) => {
      // Its result would describe a tree the agent is about to change.
      untrack(() => cancelBackgroundVerify(taskId));
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
