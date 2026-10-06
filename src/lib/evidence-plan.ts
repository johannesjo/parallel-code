import {
  VERIFY_CHECK_ID,
  type EvidenceCheckRun,
  type EvidenceFlag,
  type EvidencePackage,
  type EvidenceSkippedCheck,
  type ProjectCheck,
} from '../../electron/shared/evidence';
import { computeEvidenceConfidence } from '../../electron/shared/evidence-confidence';
import type { VerificationRun } from '../ipc/types';
import { changedDuringRun } from './verification-run';

const EXECUTION_SURFACE_RULE = 'execution-surface-changed';

export interface CheckPlanInput {
  checks: ProjectCheck[];
  dockerMode: boolean;
  dirty?: boolean;
  truncated?: boolean;
  flags: EvidenceFlag[];
  acceptedFlags: Record<string, string>;
}

export interface CheckPlan {
  run: ProjectCheck[];
  skipped: EvidenceSkippedCheck[];
}

/**
 * The execution gate. Checks run repo code on the host, so the app only runs
 * them unasked when that cannot escape the task's isolation or execute a
 * changed test harness nobody has looked at. Everything else waits for a click.
 */
export function planChecks(input: CheckPlanInput): CheckPlan {
  const surfaceChanged = input.flags.some(
    (flag) => flag.rule === EXECUTION_SURFACE_RULE && !(flag.id in input.acceptedFlags),
  );
  const plan: CheckPlan = { run: [], skipped: [] };
  for (const check of input.checks) {
    const reason =
      check.run === 'on-demand'
        ? 'on-demand'
        : input.dockerMode
          ? 'docker'
          : input.dirty
            ? 'dirty'
            : input.truncated
              ? 'incomplete'
              : surfaceChanged
                ? 'execution-surface'
                : undefined;
    if (reason)
      plan.skipped.push({ checkId: check.id, name: check.name, kind: check.kind, reason });
    else plan.run.push(check);
  }
  return plan;
}

/** The task's manual verify run, when it already tested exactly this commit. */
export function reusableVerifyRun(
  run: VerificationRun | undefined,
  check: ProjectCheck,
  headSha: string,
): EvidenceCheckRun | undefined {
  if (!run || check.id !== VERIFY_CHECK_ID || run.command !== check.command) return undefined;
  if (run.status === 'running' || run.status === 'cancelled') return undefined;
  if (run.headSha !== headSha || run.dirty || changedDuringRun(run)) return undefined;
  return { ...run, checkId: check.id, name: check.name, kind: check.kind, reused: true };
}

const SKIP_TEXT: Record<EvidenceSkippedCheck['reason'], string> = {
  'on-demand': 'runs on demand only',
  docker: 'not run automatically for Docker tasks',
  dirty: 'held back because the worktree has uncommitted changes',
  incomplete: 'held back because the integrity scan is incomplete',
  'execution-surface': 'held back because the change touches how checks run',
};

export function skipReasonText(reason: EvidenceSkippedCheck['reason']): string {
  return SKIP_TEXT[reason];
}

/** What `get_evidence` tells the agent: the app's view, never the raw logs. */
export function evidenceForAgent(
  pkg: EvidencePackage | undefined,
  checks: ProjectCheck[],
  currentHeadSha?: string | null,
  dirty?: boolean,
) {
  const configured = checks.map((check) => ({ id: check.id, name: check.name, kind: check.kind }));
  if (!pkg) return { status: 'none', checks: configured };
  const confidence = computeEvidenceConfidence(pkg, currentHeadSha, { dirty, checks });
  return {
    status: confidence.level,
    reasons: confidence.reasons.map((reason) => reason.text),
    checks: configured,
    results: pkg.checks.map((run) => ({ id: run.checkId, status: run.status })),
    skipped: pkg.skipped.map((skip) => ({ id: skip.checkId, reason: skip.reason })),
    flags: pkg.scan.flags
      .filter((flag) => flag.category !== 'info' && !(flag.id in pkg.acceptedFlags))
      .map((flag) => ({ rule: flag.rule, file: flag.file, line: flag.line, detail: flag.detail })),
  };
}

const PROMPT_TAIL_LINES = 40;

function tail(text: string): string {
  return text.split(/\r?\n/).slice(-PROMPT_TAIL_LINES).join('\n').trim();
}

export type EvidenceQuestion = { kind: 'finding'; id: string } | { kind: 'gap'; index: number };

/** Keep the selected observation and its provenance in the agent's prompt. */
export function compileEvidenceQuestion(
  pkg: EvidencePackage,
  question: EvidenceQuestion,
): string | undefined {
  let issue: string | undefined;
  if (question.kind === 'finding') {
    const finding = pkg.review?.findings.find((item) => item.id === question.id);
    if (finding && !pkg.dismissedFindings.includes(finding.id))
      issue = `AI review (${finding.severity}) — ${finding.file}:${finding.line}: ${finding.text}`;
  } else {
    const gap = pkg.claim?.notVerified?.[question.index];
    if (gap) issue = `Agent-reported verification gap: ${gap}`;
  }
  if (!issue) return undefined;
  return [
    `Please investigate this evidence item from commit ${pkg.scan.headSha}:`,
    '',
    issue,
    '',
    'Check whether it still applies to the current code. Fix it if appropriate, or explain your findings. Do not weaken tests to make checks pass.',
    'Commit any fixes, then call submit_evidence with the checks performed and anything still not verified.',
  ].join('\n');
}

/**
 * Hands open problems back to the agent. Returns undefined when there is
 * nothing to fix. Flags ask for an explanation rather than a revert, because
 * many are legitimate; only a human can accept one.
 */
export function compileEvidencePrompt(pkg: EvidencePackage): string | undefined {
  const failed = pkg.checks.filter((run) => ['failed', 'timed_out', 'error'].includes(run.status));
  const flags = pkg.scan.flags.filter(
    (flag) => flag.category === 'test-weakened' && !(flag.id in pkg.acceptedFlags),
  );
  if (failed.length === 0 && flags.length === 0) return undefined;
  const lines = ['The evidence check for this task found problems.', ''];
  for (const run of failed) {
    const exit = run.exitCode === null ? (run.message ?? run.status) : `exit ${run.exitCode}`;
    lines.push(`Check "${run.name}" failed (${exit}): \`${run.command}\``);
    if (run.outputTail.trim()) lines.push('```', tail(run.outputTail), '```');
    lines.push('');
  }
  if (flags.length > 0) {
    lines.push('These test changes look like weakened tests:');
    for (const flag of flags)
      lines.push(`- ${flag.file}${flag.line ? `:${flag.line}` : ''}: ${flag.detail}`);
    lines.push(
      '',
      'Restore the tests if the change was not intended. If it was, explain why in `notVerified` or your summary when you call submit_evidence again; never weaken a test to make it pass.',
    );
  }
  lines.push('', 'Commit your fixes, then call submit_evidence again.');
  return lines.join('\n');
}
