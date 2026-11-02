import {
  VERIFY_CHECK_ID,
  type SuiteCheckRun,
  type ScanFlag,
  type SkippedCheck,
  type ProjectCheck,
} from '../../electron/shared/checks';
import type { VerificationRun } from '../ipc/types';
import { changedDuringRun } from './verification-run';

const EXECUTION_SURFACE_RULE = 'execution-surface-changed';

export interface CheckPlanInput {
  checks: ProjectCheck[];
  dockerMode: boolean;
  dirty?: boolean;
  truncated?: boolean;
  flags: ScanFlag[];
}

export interface CheckPlan {
  run: ProjectCheck[];
  skipped: SkippedCheck[];
}

/**
 * The execution gate. Checks run repo code on the host, so the app only runs
 * them unasked when that cannot escape the task's isolation or execute a
 * changed test harness nobody has looked at. Everything else waits for a click.
 */
export function planChecks(input: CheckPlanInput): CheckPlan {
  const surfaceChanged = input.flags.some((flag) => flag.rule === EXECUTION_SURFACE_RULE);
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
): SuiteCheckRun | undefined {
  if (!run || check.id !== VERIFY_CHECK_ID || run.command !== check.command) return undefined;
  if (run.status === 'running' || run.status === 'cancelled') return undefined;
  if (run.headSha !== headSha || run.dirty || changedDuringRun(run)) return undefined;
  return { ...run, checkId: check.id, name: check.name, kind: check.kind, reused: true };
}

const SKIP_TEXT: Record<SkippedCheck['reason'], string> = {
  'on-demand': 'runs on demand only',
  docker: 'not run automatically for Docker tasks',
  dirty: 'held back because the worktree has uncommitted changes',
  incomplete: 'held back because the integrity scan is incomplete',
  'execution-surface': 'held back because the change touches how checks run',
};

export function skipReasonText(reason: SkippedCheck['reason']): string {
  return SKIP_TEXT[reason];
}

const PROMPT_TAIL_LINES = 40;

function tail(text: string): string {
  return text.split(/\r?\n/).slice(-PROMPT_TAIL_LINES).join('\n').trim();
}

/**
 * Hands failed checks back to the agent. Returns undefined when nothing failed.
 * The verify command has its own prompt, so callers pass the other checks.
 */
export function compileCheckFailurePrompt(runs: readonly SuiteCheckRun[]): string | undefined {
  const failed = runs.filter((run) => ['failed', 'timed_out', 'error'].includes(run.status));
  if (failed.length === 0) return undefined;
  const lines = ['These checks failed on this task:', ''];
  for (const run of failed) {
    const exit = run.exitCode === null ? (run.message ?? run.status) : `exit ${run.exitCode}`;
    lines.push(`Check "${run.name}" failed (${exit}): \`${run.command}\``);
    if (run.outputTail.trim()) lines.push('```', tail(run.outputTail), '```');
    lines.push('');
  }
  lines.push('Fix the cause; never weaken a test to make it pass. Commit your fixes.');
  return lines.join('\n');
}
