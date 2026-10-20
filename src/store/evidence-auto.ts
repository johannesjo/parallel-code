import { createEffect, createRoot, onCleanup } from 'solid-js';
import { computeEvidenceConfidence } from '../../electron/shared/evidence-confidence';
import { EVIDENCE_LEVEL } from '../lib/evidence-display';
import { store } from './core';
import { buildEvidence } from './evidence';
import { isLandedTaskState } from './landing';
import { NOTIFICATION_ERROR_MS, showNotification } from './notification';
import { getProject } from './projects';
import { getTaskDotStatus } from './taskStatus';

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
      if (!autoBuildEnabled(taskId) || getTaskDotStatus(taskId) === 'busy') continue;
      const previousId = store.tasks[taskId]?.evidence?.id;
      try {
        await buildEvidence(taskId, { trigger: 'auto' });
        reportProblems(taskId, previousId);
      } catch (err) {
        console.error('Background evidence build failed:', err);
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
 * Builds evidence in the background once an agent's turn ends, for projects
 * that turned it on. The build itself skips commits it already covered.
 */
export function startEvidenceAutoBuild(): () => void {
  return createRoot((dispose) => {
    const wasBusy = new Map<string, boolean>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const cancel = (taskId: string) => {
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
