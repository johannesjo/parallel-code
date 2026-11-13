import type { SuiteCheckRun } from '../../electron/shared/checks';
import type { VerificationRun } from '../ipc/types';
import type { TaskBriefRecord } from './task-brief';
import { isConfidenceOutdated, type TaskConfidence } from './task-confidence';

/** When the user last had a task open, and the code it was on then. */
export interface TaskVisit {
  at: number;
  headSha?: string;
  /** Newest diff fingerprint read by then, so a re-read of the same code is not news. */
  codeFingerprint?: string;
}

/** Restores a persisted visit; a malformed one is dropped, so nothing is claimed as new. */
export function restoreTaskVisit(value: unknown): TaskVisit | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { at, headSha, codeFingerprint } = value as Record<string, unknown>;
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  return {
    at,
    ...(typeof headSha === 'string' && { headSha: headSha.slice(0, 64) }),
    ...(typeof codeFingerprint === 'string' && { codeFingerprint: codeFingerprint.slice(0, 64) }),
  };
}

type RunResult = Pick<VerificationRun, 'status' | 'finishedAt'>;

export interface VisitChangesInput {
  visit: TaskVisit | undefined;
  headSha: string | null | undefined;
  confidence?: Pick<TaskConfidence, 'publishedAt' | 'fingerprint'>;
  codeFingerprint?: { fingerprint: string; at: number };
  brief?: Pick<TaskBriefRecord, 'generatedAt' | 'fingerprint'>;
  verificationRun?: RunResult;
  checks?: readonly (RunResult & Pick<Partial<SuiteCheckRun>, 'reused'>)[];
}

/** Outcome of the runs that finished after `at`: any failure wins; cancelled runs say nothing. */
function outcomeSince(runs: readonly RunResult[], at: number): 'passed' | 'failed' | undefined {
  const finished = runs.filter(
    (run) =>
      (run.status === 'passed' || run.status === 'failed') &&
      run.finishedAt !== null &&
      Date.parse(run.finishedAt) > at,
  );
  if (finished.some((run) => run.status === 'failed')) return 'failed';
  return finished.length ? 'passed' : undefined;
}

function ratingOutdatedSince(input: VisitChangesInput, visit: TaskVisit): boolean {
  const latest = input.codeFingerprint
    ? { at: input.codeFingerprint.at, fingerprint: input.codeFingerprint.fingerprint }
    : input.brief && { at: input.brief.generatedAt, fingerprint: input.brief.fingerprint };
  return Boolean(
    input.confidence &&
    latest &&
    latest.at > visit.at &&
    latest.fingerprint !== visit.codeFingerprint &&
    isConfidenceOutdated(input.confidence, input.codeFingerprint, input.brief),
  );
}

/**
 * What the app itself observed since the visit: git HEAD, diff fingerprints,
 * and its own verify and check runs. Agent self-reports are deliberately not
 * inputs — this line separates receipts from claims.
 */
export function changesSinceVisit(input: VisitChangesInput): string[] {
  const { visit } = input;
  if (!visit) return [];
  const changes: string[] = [];
  // shortcut: HEAD moved, not a count — counting needs a rev-list IPC.
  if (visit.headSha && input.headSha && input.headSha !== visit.headSha)
    changes.push('new commits');
  if (ratingOutdatedSince(input, visit)) changes.push('rating outdated');
  const verify = outcomeSince(input.verificationRun ? [input.verificationRun] : [], visit.at);
  if (verify) changes.push('verify ' + verify);
  // A reused check is the verify run above, already reported.
  const checks = outcomeSince(
    (input.checks ?? []).filter((check) => !check.reused),
    visit.at,
  );
  if (checks) changes.push('checks ' + checks);
  return changes;
}
