import type { MergeStatus, PrChecksOverall, VerificationRun, WorktreeStatus } from '../ipc/types';
import {
  formatCoverageDelta,
  isBaselineInformational,
  MATERIAL_COVERAGE_DELTA,
  type CoverageComparison,
} from '../lib/coverage-comparison';
import type { SubtaskVerification } from '../store/types';
import {
  summarizeVerificationRun,
  usesVerificationRun,
  type VerificationSummaryKind,
} from '../lib/verification-run';

export type MergeReadinessCheckStatus = 'pass' | 'warning' | 'blocked' | 'checking' | 'neutral';

export interface MergeReadinessCheck {
  label: string;
  status: MergeReadinessCheckStatus;
  detail: string;
}

export interface MergeReadiness {
  overall: 'ready' | 'attention' | 'blocked' | 'checking';
  checks: MergeReadinessCheck[];
}

interface PrReadinessState {
  overall: PrChecksOverall;
  passing: number;
  pending: number;
  failing: number;
}

export interface MergeReadinessInput {
  expectedBranch: string;
  mergeStatus?: MergeStatus;
  mergeStatusLoading: boolean;
  worktreeStatus?: WorktreeStatus;
  worktreeStatusLoading: boolean;
  /** Agent self-report from land_self; only consulted without a verify command. */
  verification?: SubtaskVerification;
  /** Result of the app running the project's verify command in the worktree. */
  verificationRun?: VerificationRun;
  verifyCommandConfigured?: boolean;
  prChecks?: PrReadinessState;
  coverage?: CoverageComparison | null;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function mergeSafetyCheck(input: MergeReadinessInput): MergeReadinessCheck {
  if (input.mergeStatusLoading || input.worktreeStatusLoading) {
    return { label: 'Merge safety', status: 'checking', detail: 'Checking merge safety…' };
  }

  const merge = input.mergeStatus;
  const worktree = input.worktreeStatus;
  if (worktree?.current_branch === null) {
    return {
      label: 'Merge safety',
      status: 'blocked',
      detail: 'Worktree has a detached HEAD.',
    };
  }
  if (worktree && worktree.current_branch !== input.expectedBranch) {
    return {
      label: 'Merge safety',
      status: 'blocked',
      detail: `Worktree is on '${worktree.current_branch}', expected '${input.expectedBranch}'.`,
    };
  }
  if (merge && merge.conflicting_files.length > 0) {
    return {
      label: 'Merge safety',
      status: 'blocked',
      detail: `${countLabel(merge.conflicting_files.length, 'conflicting file')} must be resolved.`,
    };
  }
  if (worktree && !worktree.has_committed_changes) {
    return {
      label: 'Merge safety',
      status: 'blocked',
      detail: 'No committed changes are available to merge.',
    };
  }
  if (!merge || !worktree) {
    return {
      label: 'Merge safety',
      status: 'warning',
      detail: 'Merge safety could not be checked.',
    };
  }
  if (merge.main_ahead_count > 0) {
    return {
      label: 'Merge safety',
      status: 'warning',
      detail: `${merge.base_branch} is ${countLabel(merge.main_ahead_count, 'commit')} ahead. Rebase recommended.`,
    };
  }
  if (worktree.has_uncommitted_changes) {
    return {
      label: 'Merge safety',
      status: 'warning',
      detail: 'Uncommitted changes will be excluded.',
    };
  }
  return { label: 'Merge safety', status: 'pass', detail: 'Branch is mergeable.' };
}

const RUN_KIND_STATUS: Record<VerificationSummaryKind, MergeReadinessCheckStatus> = {
  none: 'warning',
  running: 'checking',
  passed: 'pass',
  stale: 'warning',
  dirty: 'warning',
  failed: 'warning',
  unavailable: 'warning',
};

function verificationRunCheck(
  run: VerificationRun | undefined,
  headSha: string | null | undefined,
): MergeReadinessCheck {
  const summary = summarizeVerificationRun(run, headSha);
  return {
    label: 'Verification',
    status: RUN_KIND_STATUS[summary.kind],
    detail: summary.kind === 'running' ? summary.detail : `${summary.label}. ${summary.detail}`,
  };
}

function verificationCheck(input: MergeReadinessInput): MergeReadinessCheck {
  if (usesVerificationRun(input.verificationRun, Boolean(input.verifyCommandConfigured))) {
    return verificationRunCheck(input.verificationRun, input.worktreeStatus?.head_sha);
  }
  return reportedVerificationCheck(input.verification);
}

function reportedVerificationCheck(verification?: SubtaskVerification): MergeReadinessCheck {
  if (!verification?.checks.length) {
    return {
      label: 'Verification',
      status: 'warning',
      detail: 'No verification was reported.',
    };
  }
  const failed = verification.checks.find((check) => check.result !== 'passed');
  if (failed) {
    return {
      label: 'Verification',
      status: 'warning',
      detail: `${failed.name} ${failed.result}${failed.reason ? ` — ${failed.reason}` : ''}`,
    };
  }
  return {
    label: 'Verification',
    status: 'pass',
    detail: `${countLabel(verification.checks.length, 'check')} passed.`,
  };
}

function prCheck(prChecks?: PrReadinessState): MergeReadinessCheck {
  if (!prChecks || prChecks.overall === 'none') {
    return { label: 'PR checks', status: 'neutral', detail: 'No PR checks available.' };
  }
  if (prChecks.overall === 'pending') {
    const failing = prChecks.failing
      ? `, ${countLabel(prChecks.failing, 'failing', 'failing')}`
      : '';
    return {
      label: 'PR checks',
      status: 'warning',
      detail: `${countLabel(prChecks.pending, 'pending', 'pending')}, ${countLabel(prChecks.passing, 'passing', 'passing')}${failing}.`,
    };
  }
  if (prChecks.overall === 'failure') {
    const pending = prChecks.pending
      ? `, ${countLabel(prChecks.pending, 'pending', 'pending')}`
      : '';
    return {
      label: 'PR checks',
      status: 'warning',
      detail: `${countLabel(prChecks.failing, 'failing', 'failing')}, ${countLabel(prChecks.passing, 'passing', 'passing')}${pending}.`,
    };
  }
  return {
    label: 'PR checks',
    status: 'pass',
    detail: `${countLabel(prChecks.passing, 'check')} passed.`,
  };
}

function coverageCheck(
  coverage?: CoverageComparison | null,
  mergeStatus?: MergeStatus,
): MergeReadinessCheck {
  const aggregate = coverage?.aggregate;
  if (!aggregate || aggregate.task.state === 'no-report') {
    return { label: 'Coverage', status: 'neutral', detail: 'No task coverage report.' };
  }
  if (aggregate.task.state === 'no-executable-lines') {
    return {
      label: 'Coverage',
      status: 'neutral',
      detail: 'The task coverage report has no executable lines.',
    };
  }

  const taskPct = aggregate.task.pct;
  if (aggregate.base.state === 'no-report') {
    return {
      label: 'Coverage',
      status: 'neutral',
      detail: `Task ${taskPct}%; no base coverage report.`,
    };
  }
  if (aggregate.base.state === 'no-executable-lines' || aggregate.delta === null) {
    return {
      label: 'Coverage',
      status: 'neutral',
      detail: `Task ${taskPct}%; the base report has no executable lines.`,
    };
  }
  if (coverage.inventoryState && coverage.inventoryState !== 'available') {
    return {
      label: 'Coverage',
      status: 'neutral',
      detail:
        coverage.inventoryState === 'loading'
          ? `Task ${taskPct}%; changed-file inventory is still loading, so comparison is informational only.`
          : `Task ${taskPct}%; changed-file inventory is unavailable, so comparison is informational only.`,
    };
  }
  if (mergeStatus && mergeStatus.main_ahead_count > 0) {
    return {
      label: 'Coverage',
      status: 'neutral',
      detail: `${mergeStatus.base_branch} is ${countLabel(mergeStatus.main_ahead_count, 'commit')} ahead; rebase and regenerate task coverage before comparing.`,
    };
  }
  if (isBaselineInformational(coverage.baseline)) {
    const baseBranch = coverage.baseline?.baseBranch ?? 'base branch';
    return {
      label: 'Coverage',
      status: 'neutral',
      detail: coverage.baseline?.taskStale
        ? 'Task coverage report predates task HEAD; regenerate it before comparing.'
        : coverage.baseline?.taskUnanchored
          ? 'Task coverage report cannot be anchored to task HEAD; comparison is informational only.'
          : coverage.baseline?.stale
            ? `Base coverage report predates ${baseBranch} as currently checked out; regenerate it before comparing.`
            : `Base coverage report cannot be anchored to ${baseBranch} as currently checked out; comparison is informational only.`,
    };
  }

  const regressedUnchanged = coverage.impactedUnchangedFiles.filter(
    (file) =>
      file.base.state === 'available' &&
      file.task.state === 'available' &&
      file.delta !== null &&
      file.delta <= -MATERIAL_COVERAGE_DELTA,
  );
  const impactedDetail =
    regressedUnchanged.length > 0
      ? ` ${countLabel(regressedUnchanged.length, 'unchanged file')} also regressed.`
      : '';
  return {
    label: 'Coverage',
    status:
      aggregate.delta <= -MATERIAL_COVERAGE_DELTA || regressedUnchanged.length > 0
        ? 'warning'
        : 'pass',
    detail: `Base ${aggregate.base.pct}% → task ${taskPct}% (${formatCoverageDelta(aggregate.delta)}).${impactedDetail}`,
  };
}

export function buildMergeReadiness(input: MergeReadinessInput): MergeReadiness {
  const checks = [
    mergeSafetyCheck(input),
    verificationCheck(input),
    coverageCheck(input.coverage, input.mergeStatus),
    prCheck(input.prChecks),
  ];
  const overall = checks.some((check) => check.status === 'blocked')
    ? 'blocked'
    : checks.some((check) => check.status === 'checking')
      ? 'checking'
      : checks.some((check) => check.status === 'warning')
        ? 'attention'
        : 'ready';
  return { overall, checks };
}
