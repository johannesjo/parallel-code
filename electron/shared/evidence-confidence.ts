/**
 * The confidence band of an evidence package, computed from observed facts.
 * Agent and model statements can only lower it. Renderer-safe.
 */
import type {
  EvidenceCheckRun,
  EvidencePackage,
  EvidenceSkipReason,
  ProjectCheck,
} from './evidence.js';

export type EvidenceConfidenceLevel = 'checking' | 'not-checked' | 'low' | 'medium' | 'high';

export interface EvidenceReason {
  level: Exclude<EvidenceConfidenceLevel, 'high'>;
  text: string;
}

export interface EvidenceConfidence {
  level: EvidenceConfidenceLevel;
  /** Every reason that held, most severe first; the first one decided the level. */
  reasons: EvidenceReason[];
}

const PRECEDENCE: EvidenceReason['level'][] = ['checking', 'not-checked', 'low', 'medium'];

const FAILED_STATUSES = new Set(['failed', 'timed_out', 'error']);

const SKIP_WHY: Record<EvidenceSkipReason, string> = {
  'on-demand': 'is on-demand and was not run',
  dirty: 'waits for your click (uncommitted changes)',
  incomplete: 'waits for your click (incomplete scan)',
  docker: 'waits for your click (Docker task)',
  'execution-surface': 'waits for your click (test setup or scripts changed)',
};

function changedDuringRun(run: EvidenceCheckRun, headSha: string): boolean {
  if (run.headSha !== headSha || run.dirty) return true;
  if (run.headShaAfter !== undefined && run.headShaAfter !== headSha) return true;
  return run.dirtyAfter === true;
}

function freshnessReasons(pkg: EvidencePackage, currentHeadSha?: string | null): EvidenceReason[] {
  const reasons: EvidenceReason[] = [];
  const { headSha } = pkg.scan;
  if (pkg.scan.dirty)
    reasons.push({ level: 'not-checked', text: 'Uncommitted changes: commit, then rebuild.' });
  if (currentHeadSha && currentHeadSha !== headSha)
    reasons.push({ level: 'not-checked', text: 'New commits since the evidence was built.' });
  const finished = pkg.checks.filter((run) => run.status !== 'running');
  if (finished.some((run) => changedDuringRun(run, headSha)))
    reasons.push({ level: 'not-checked', text: 'The code changed while checks ran.' });
  return reasons;
}

function checkReasons(pkg: EvidencePackage): EvidenceReason[] {
  const reasons: EvidenceReason[] = [];
  for (const run of pkg.checks) {
    if (FAILED_STATUSES.has(run.status))
      reasons.push({ level: 'low', text: `${run.name} ${run.status.replace('_', ' ')}.` });
    if (run.status === 'cancelled')
      reasons.push({ level: 'medium', text: `${run.name} was cancelled.` });
  }
  for (const claim of pkg.claim?.checkResults ?? []) {
    const run = pkg.checks.find((candidate) => candidate.checkId === claim.checkId);
    if (run && claim.result === 'passed' && FAILED_STATUSES.has(run.status))
      reasons.push({ level: 'low', text: `The agent said ${run.name} passed; it did not.` });
  }
  if (!pkg.checks.some((run) => run.status === 'passed' || FAILED_STATUSES.has(run.status)))
    reasons.push({ level: 'low', text: 'Nothing was executed.' });
  for (const skip of pkg.skipped) {
    reasons.push({ level: 'medium', text: `${skip.name} ${SKIP_WHY[skip.reason]}.` });
  }
  return reasons;
}

function flagReasons(pkg: EvidencePackage): EvidenceReason[] {
  const open = pkg.scan.flags.filter((flag) => !(flag.id in pkg.acceptedFlags));
  const weakened = open.filter((flag) => flag.category === 'test-weakened').length;
  const decisions = open.filter((flag) => flag.category === 'needs-decision').length;
  const reasons: EvidenceReason[] = [];
  if (weakened > 0)
    reasons.push({ level: 'low', text: `${weakened} test change(s) look like weakened tests.` });
  if (decisions > 0)
    reasons.push({ level: 'medium', text: `${decisions} change(s) need your decision.` });
  return reasons;
}

function statementReasons(pkg: EvidencePackage): EvidenceReason[] {
  const reasons: EvidenceReason[] = [];
  const untested = pkg.scan.sourceWithoutTests.length;
  if (untested > 0)
    reasons.push({
      level: 'medium',
      text: `No related tests found for ${untested} changed source file(s).`,
    });
  const blockers = (pkg.review?.findings ?? []).filter(
    (finding) => finding.severity === 'blocker' && !pkg.dismissedFindings.includes(finding.id),
  ).length;
  if (blockers > 0)
    reasons.push({ level: 'medium', text: `The model raised ${blockers} blocker(s).` });
  if (!pkg.claim) reasons.push({ level: 'medium', text: 'The agent did not hand off.' });
  else if ((pkg.claim.notVerified?.length ?? 0) > 0)
    reasons.push({
      level: 'medium',
      text: `The agent did not check ${pkg.claim.notVerified?.length} thing(s).`,
    });
  return reasons;
}

interface CurrentState {
  dirty?: boolean;
  checks?: ProjectCheck[];
}

function sameCheck(saved: ProjectCheck, check: ProjectCheck): boolean {
  return (
    saved.id === check.id &&
    saved.command === check.command &&
    saved.kind === check.kind &&
    saved.run === check.run
  );
}

/** Reasons the package no longer describes the worktree and settings as they are now. */
function currentStateReasons(pkg: EvidencePackage, current: CurrentState): EvidenceReason[] {
  const configurationChanged =
    current.checks !== undefined &&
    (!pkg.configuredChecks ||
      current.checks.length !== pkg.configuredChecks.length ||
      current.checks.some(
        (check) => !pkg.configuredChecks?.some((saved) => sameCheck(saved, check)),
      ));
  const expectedChecks = current.checks ?? pkg.configuredChecks;
  const resultsChanged =
    expectedChecks !== undefined &&
    pkg.checks.some((run) => {
      const check = expectedChecks.find((candidate) => candidate.id === run.checkId);
      return !check || check.command !== run.command || check.kind !== run.kind;
    });
  const reasons: EvidenceReason[] = [];
  if (resultsChanged)
    reasons.push({
      level: 'not-checked',
      text: 'Check results do not match the configured commands: rebuild evidence.',
    });
  if (configurationChanged)
    reasons.push({
      level: 'not-checked',
      text: 'Check configuration changed or was not recorded: rebuild evidence.',
    });
  if (current.dirty && !pkg.scan.dirty)
    reasons.push({ level: 'not-checked', text: 'The worktree now has uncommitted changes.' });
  if (pkg.scan.truncated)
    reasons.push({
      level: 'medium',
      text: 'The integrity scan is incomplete; some changes were not inspected.',
    });
  return reasons;
}

/**
 * Ordered cascade (docs/evidence-packages.md §5): in-flight beats stale,
 * stale beats low, low beats medium; with no reason left the band is high.
 * Every state maps to exactly one level.
 */
export function computeEvidenceConfidence(
  pkg: EvidencePackage,
  currentHeadSha?: string | null,
  current: CurrentState = {},
): EvidenceConfidence {
  if (pkg.assembling || pkg.checks.some((run) => run.status === 'running'))
    return { level: 'checking', reasons: [{ level: 'checking', text: 'Checks are running.' }] };
  const reasons = [
    ...currentStateReasons(pkg, current),
    ...freshnessReasons(pkg, currentHeadSha),
    ...checkReasons(pkg),
    ...flagReasons(pkg),
    ...statementReasons(pkg),
  ].sort((a, b) => PRECEDENCE.indexOf(a.level) - PRECEDENCE.indexOf(b.level));
  return { level: reasons[0]?.level ?? 'high', reasons };
}
