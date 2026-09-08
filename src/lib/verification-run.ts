import type { VerificationRun } from '../ipc/types';

export type VerificationSummaryKind =
  | 'none'
  | 'running'
  | 'passed'
  | 'stale'
  | 'dirty'
  | 'failed'
  | 'unavailable';

/** A configured command makes the app-run result authoritative; the agent's
 *  own report only counts for projects that never configured one. */
export function usesVerificationRun(
  run: VerificationRun | undefined,
  commandConfigured: boolean,
): boolean {
  return commandConfigured || run !== undefined;
}

export interface VerificationSummary {
  kind: VerificationSummaryKind;
  label: string;
  detail: string;
}

/** Lines of output quoted back to the agent when a run fails. */
export const VERIFY_PROMPT_TAIL_LINES = 60;

export function lastOutputLine(tail: string): string {
  const lines = tail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

export function isVerificationStale(
  run: VerificationRun,
  currentHeadSha: string | null | undefined,
): boolean {
  return Boolean(currentHeadSha && run.headSha && run.headSha !== currentHeadSha);
}

/** Pure read model shared by the merge-readiness row, the title bar and the
 *  verification panel, so they never disagree about what a run means. */
export function summarizeVerificationRun(
  run: VerificationRun | undefined,
  currentHeadSha?: string | null,
): VerificationSummary {
  if (!run) {
    return { kind: 'none', label: 'Not verified', detail: 'Run the project verify command.' };
  }
  const stale = isVerificationStale(run, currentHeadSha);
  const olderCommit = stale ? ' at an older commit' : '';
  switch (run.status) {
    case 'running':
      return { kind: 'running', label: 'Running', detail: `Running \`${run.command}\`…` };
    case 'passed':
      if (stale) {
        return {
          kind: 'stale',
          label: 'Verified at an older commit',
          detail: 'Re-run to cover the latest changes.',
        };
      }
      if (run.dirty) {
        return {
          kind: 'dirty',
          label: 'Passed with uncommitted changes',
          detail: 'Commit and re-run so the merged tree is what was verified.',
        };
      }
      return { kind: 'passed', label: 'Passed', detail: `\`${run.command}\` exited 0.` };
    case 'failed': {
      const exit = run.exitCode === null ? '' : ` (exit ${run.exitCode})`;
      const last = lastOutputLine(run.outputTail) || run.message || 'No output.';
      return { kind: 'failed', label: `Failed${exit}${olderCommit}`, detail: last };
    }
    case 'timed_out':
      return { kind: 'failed', label: `Timed out${olderCommit}`, detail: run.message ?? '' };
    case 'cancelled':
      return { kind: 'unavailable', label: 'Cancelled', detail: 'Run it again when ready.' };
    case 'error':
      return {
        kind: 'unavailable',
        label: 'Could not run',
        detail: run.message ?? 'The verify command failed to start.',
      };
  }
}

/** Solid's setStore merges objects, so an optional key missing from a new run
 *  would keep the previous run's value. Spelling it out makes the merge drop it. */
export function asStoreVerificationRun(run: VerificationRun): VerificationRun {
  return { message: undefined, ...run };
}

/** Prompt that hands a failing run back to the agent, mirroring how diff
 *  review feedback is compiled. Passing runs are never sent. */
export function compileVerificationFailurePrompt(run: VerificationRun): string {
  const tailLines = run.outputTail.split(/\r?\n/).slice(-VERIFY_PROMPT_TAIL_LINES).join('\n');
  const exit = run.exitCode === null ? (run.message ?? 'unknown') : String(run.exitCode);
  return [
    "The project's verification command failed. Fix the failures, then run it again until it passes.",
    '',
    `Command: \`${run.command}\``,
    `Exit code: ${exit}`,
    '',
    'Output (last lines):',
    '```',
    tailLines.trim(),
    '```',
    '',
  ].join('\n');
}
