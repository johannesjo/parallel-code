import type { CheckSuite } from '../../electron/shared/checks';
import type { SubtaskVerification } from '../../electron/shared/completion-report';
import type { VerificationRun, WorktreeStatus } from '../ipc/types';
import { buildReviewSummary, type ReviewDismissal } from './review-summary';
import { LOW_CONFIDENCE_SCORE, type TaskConfidence } from './task-confidence';
import { isFailedRunStatus, summarizeVerificationRun } from './verification-run';

export interface LocalMergeReadinessInput {
  /** The latest git status read; a placeholder that was never read has no `refreshedAt`. */
  git?: Pick<WorktreeStatus, 'has_committed_changes' | 'has_uncommitted_changes' | 'head_sha'> & {
    refreshedAt: number;
    error?: string;
  };
  confidence?: TaskConfidence;
  /** The code changed after the rating. */
  reviewOutdated: boolean;
  /** Review items the user set aside, by item id. */
  dismissed?: Record<string, ReviewDismissal>;
  /** Without a verify command, an old run left behind holds nothing back. */
  verifyCommandConfigured: boolean;
  verificationRun?: VerificationRun;
  /** The agent's own report, consulted only without a verify command. */
  verification?: SubtaskVerification;
  evidence?: CheckSuite;
}

/**
 * Whether a task that merges locally can merge as it is: the app's own review
 * read the current code and found nothing open, and no check failed on the
 * current commit. Without a review of this very commit nothing vouches for
 * the work, so it is not ready. A rating the task's agent published about
 * itself does not count.
 *
 * A git read in flight or past its polling age still counts: its commit and
 * fingerprint only change when the code does, and the review and verify
 * results compare against those. Otherwise each refresh would move the card
 * out of the lane and back.
 */
export function isReadyToMergeLocally(input: LocalMergeReadinessInput): boolean {
  const { git, confidence } = input;
  if (!git || git.error || git.refreshedAt <= 0) return false;
  if (!git.has_committed_changes || git.has_uncommitted_changes) return false;
  const head = git.head_sha;
  if (!head) return false;

  // Tied to the commit it read: diff fingerprints are only re-read now and then,
  // so they alone would let a review of older code vouch for a new commit.
  if (confidence?.origin !== 'review' || confidence.headSha !== head) return false;
  if (input.reviewOutdated) return false;
  if (confidence.scores.some((entry) => entry.score < LOW_CONFIDENCE_SCORE)) return false;
  // The same risks the Finish dialog lists; doubts the reviewer did not
  // confirm stay listed there but do not hold the merge.
  const { risks } = buildReviewSummary({ confidence, dismissed: input.dismissed });
  if (risks.some((risk) => !risk.dismissed && !risk.unconfirmed)) return false;

  if (input.verifyCommandConfigured) {
    if (summarizeVerificationRun(input.verificationRun, head).kind !== 'passed') return false;
  } else if (input.verification?.checks?.some((check) => check.result !== 'passed')) {
    return false;
  }

  // A check run on an older commit says nothing about this one.
  const suite = input.evidence;
  if (suite && suite.scan.headSha === head) {
    if (suite.checks.some((check) => isFailedRunStatus(check.status))) return false;
  }
  return true;
}
