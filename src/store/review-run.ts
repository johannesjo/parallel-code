import type { ProjectCheck } from '../../electron/shared/checks';
import { errMessage, warn as logWarn } from '../lib/log';
import { store } from './core';
import { runCheckSuite, stopCheckSuite } from './check-suite';
import { getTaskChecks, isCheckSuiteBusy } from './check-suite-state';
import { getProject, updateProject } from './projects';
import type { ReviewCheckResult } from '../lib/task-review';
import { cancelTaskReview, startTaskReview } from './task-review';

/**
 * Saves which checks reviews run in the task's project, adding the suggested
 * checks the user picked to the project's own.
 */
export function setReviewChecks(
  taskId: string,
  pick: { ids: readonly string[]; newChecks?: readonly ProjectCheck[]; verifyCommand?: string },
): void {
  const task = store.tasks[taskId];
  const project = task && getProject(task.projectId);
  if (!project) return;
  updateProject(project.id, {
    reviewChecks: [...pick.ids],
    ...(pick.newChecks?.length && {
      evidenceChecks: [...(project.evidenceChecks ?? []), ...pick.newChecks],
    }),
    ...(pick.verifyCommand &&
      !project.verifyCommand?.trim() && { verifyCommand: pick.verifyCommand }),
  });
}

/**
 * How each picked check ended in the suite just run; one still running is left
 * out. A run that stopped before making its suite (a failed scan) leaves
 * the previous one, from older code, which must not pass as this code's result.
 */
function checkResults(
  taskId: string,
  only: readonly string[],
  previousId: string | undefined,
): ReviewCheckResult[] {
  const pkg = store.tasks[taskId]?.evidence;
  if (!pkg || pkg.id === previousId) return [];
  const ran = (pkg.checks ?? [])
    .filter((run) => only.includes(run.checkId) && run.status !== 'running')
    .map((run) => ({ name: run.name, result: run.status.replace('_', ' ') }));
  const skipped = (pkg.skipped ?? [])
    .filter((check) => only.includes(check.checkId))
    .map((check) => ({ name: check.name, result: `skipped: ${check.reason}` }));
  return [...ran, ...skipped];
}

/**
 * Starts a review: the checks picked for the project as one check-suite run, so
 * the gate that holds risky checks back still decides what runs, and the
 * reviewer model, which waits for their results so it can weigh them. Both run
 * in the background.
 */
export function startReview(taskId: string): void {
  const task = store.tasks[taskId];
  // A second start while one runs would restart the checks under it.
  if (!task || task.reviewStatus?.state === 'running') return;
  const picked = getProject(task.projectId)?.reviewChecks ?? [];
  const only = getTaskChecks(taskId)
    .map((check) => check.id)
    .filter((id) => picked.includes(id));
  const previousId = task.evidence?.id;
  const checks =
    only.length > 0
      ? runCheckSuite(taskId, { only }).then(
          () => checkResults(taskId, only, previousId),
          (error: unknown) => {
            logWarn('taskReview', 'Review checks failed', { taskId, error: errMessage(error) });
            return [];
          },
        )
      : undefined;
  void startTaskReview(taskId, checks);
}

/** Stops the reviewer model and the review's check run with it. */
export function cancelReview(taskId: string): void {
  cancelTaskReview(taskId);
  const pkg = store.tasks[taskId]?.evidence;
  if (pkg && isCheckSuiteBusy(pkg)) void stopCheckSuite(taskId);
}
