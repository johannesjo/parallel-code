import { VERIFY_CHECK_ID } from '../../electron/shared/checks';
import { isReadyToMergeLocally } from '../lib/local-merge-readiness';
import { isConfidenceOutdated } from '../lib/task-confidence';
import { getTaskChecks } from './check-suite-state';
import { store } from './core';
import { isLandedTaskState } from './landing';
import type { Task } from './types';

function hasVerifyCommand(taskId: string): boolean {
  return getTaskChecks(taskId).some((check) => check.id === VERIFY_CHECK_ID && !!check.command);
}

/** What vouches for a task in Ready to merge without a pull request. */
export function localMergeLabel(task: Task): string {
  return hasVerifyCommand(task.id) ? 'Review and verify passed' : 'Review passed';
}

/**
 * Whether a worktree task without a pull request can be merged from Finish as
 * it is: the app's review of the current code found nothing open and no check
 * failed on its commit. See `isReadyToMergeLocally`.
 */
export function isTaskReadyToMergeLocally(task: Task): boolean {
  if (task.gitIsolation !== 'worktree' || isLandedTaskState(task.landingState)) return false;
  const confidence = task.confidence;
  return isReadyToMergeLocally({
    git: store.taskGitStatus[task.id],
    confidence,
    reviewOutdated:
      !!confidence && isConfidenceOutdated(confidence, task.codeFingerprint, task.brief),
    dismissed: task.reviewDismissed,
    verifyCommandConfigured: hasVerifyCommand(task.id),
    verificationRun: task.verificationRun,
    verification: task.verification,
    evidence: task.evidence,
  });
}
