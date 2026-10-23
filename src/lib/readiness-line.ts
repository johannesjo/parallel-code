import type { EvidenceSkipReason } from '../../electron/shared/evidence';
import type { SubtaskVerification } from '../../electron/shared/completion-report';
import type { VerificationRun } from '../ipc/types';
import type { VerifyPassRecord } from '../store/types';
import { skipReasonText } from './evidence-plan';
import { formatRelativeAge } from './relativeAge';
import {
  earlierPass,
  isVerificationStale,
  summarizeVerificationRun,
  usesVerificationRun,
} from './verification-run';

export type ReadinessAction = 'run' | 'rerun' | 'cancel' | 'stage' | 'configure';

/** One line in the Finish dialog: what ran on this commit, and the next step. */
export interface ReadinessLine {
  /** Colour is kept for failures; everything else reads as plain text. */
  tone: 'neutral' | 'failed';
  text: string;
  detail: string;
  action?: ReadinessAction;
}

export interface ReadinessLineInput {
  verifyCommand?: string;
  run?: VerificationRun;
  /** Agent self-report from land_self; only consulted without a verify command. */
  verification?: SubtaskVerification;
  headSha?: string | null;
  /** Why the background run skipped the current commit. */
  hold?: { headSha: string; reason: EvidenceSkipReason };
  lastPass?: VerifyPassRecord;
  /** Full hashes of the branch's commits, oldest first. */
  branchCommits?: readonly string[];
  /** Whether the project runs verify in the background after agent turns. */
  autoRun: boolean;
  now: number;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function ago(iso: string | null | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return '';
  const age = formatRelativeAge(at, now);
  return age === 'just now' ? age : `${age} ago`;
}

/** "last passed 2 commits ago (a1b2c3d)", or "" when no earlier pass applies. */
export function lastPassText(
  run: VerificationRun,
  lastPass: VerifyPassRecord | undefined,
  branchCommits: readonly string[] | undefined,
): string {
  const pass = earlierPass(run, lastPass);
  if (!pass) return '';
  const index = branchCommits?.indexOf(pass.headSha) ?? -1;
  const behind = index >= 0 && branchCommits ? branchCommits.length - 1 - index : -1;
  const where =
    behind > 0 ? `${behind} commit${behind === 1 ? '' : 's'} ago` : `at ${shortSha(pass.headSha)}`;
  return behind > 0 ? `last passed ${where} (${shortSha(pass.headSha)})` : `last passed ${where}`;
}

function joined(...parts: string[]): string {
  return parts.filter(Boolean).join(' · ');
}

function reportedLine(verification: SubtaskVerification | undefined): ReadinessLine {
  const checks = verification?.checks ?? [];
  if (checks.length === 0)
    return {
      tone: 'neutral',
      text: 'No verify command',
      detail: 'Set one and each new commit is checked in the background.',
      action: 'configure',
    };
  const failed = checks.find((check) => check.result !== 'passed');
  if (failed)
    return {
      tone: 'failed',
      text: `Agent reports ${failed.name} ${failed.result === 'blocked' ? 'blocked' : 'failed'}`,
      detail: failed.reason ?? failed.command,
    };
  return {
    tone: 'neutral',
    text: 'Agent reports its checks passed',
    detail: 'Not run by the app. Set a verify command to have it checked.',
    action: 'configure',
  };
}

/**
 * Pure read model for the readiness line. It states what ran on which commit
 * and who ran it, never more: a pass on an older commit or with uncommitted
 * changes says so, and only a failure is coloured.
 */
export function readinessLine(input: ReadinessLineInput): ReadinessLine {
  if (!usesVerificationRun(input.run, Boolean(input.verifyCommand)))
    return reportedLine(input.verification);
  const run = input.run;
  const command = run?.command ?? input.verifyCommand ?? '';
  if (!run || run.status === 'cancelled') {
    const held = input.hold && input.hold.headSha === input.headSha ? input.hold : undefined;
    return {
      tone: 'neutral',
      text: 'Not tested on this commit',
      detail: held
        ? `Background run ${skipReasonText(held.reason)}.`
        : input.autoRun
          ? `\`${command}\` runs in the background after the agent's next turn.`
          : `\`${command}\``,
      action: 'run',
    };
  }
  const summary = summarizeVerificationRun(run, input.headSha);
  const sha = run.headSha ? shortSha(run.headSha) : '';
  switch (summary.kind) {
    case 'running':
      return {
        tone: 'neutral',
        text: 'Verify running',
        detail: joined(`\`${command}\``, `started ${ago(run.startedAt, input.now)}`),
        action: 'cancel',
      };
    case 'passed':
      return {
        tone: 'neutral',
        text: 'Verify passed',
        detail: joined(sha && `on ${sha}`, ago(run.finishedAt, input.now)),
        action: 'rerun',
      };
    case 'stale':
      return {
        tone: 'neutral',
        text: 'Not tested on this commit',
        detail: joined(sha && `passed on ${sha}`, ago(run.finishedAt, input.now)),
        action: 'run',
      };
    case 'dirty':
      return {
        tone: 'neutral',
        text: 'Verify passed with uncommitted changes',
        detail: 'Those changes are not part of the merge; commit and run again.',
        action: 'run',
      };
    case 'failed':
      return {
        tone: 'failed',
        text: `Verify ${summary.label.charAt(0).toLowerCase()}${summary.label.slice(1)}`,
        detail: joined(summary.detail, lastPassText(run, input.lastPass, input.branchCommits)),
        // A failure on an older commit may be fixed already; run it again first.
        action: isVerificationStale(run, input.headSha) ? 'run' : 'stage',
      };
    case 'unavailable':
    case 'none':
      return { tone: 'neutral', text: summary.label, detail: summary.detail, action: 'run' };
  }
}

const OVERLAP_NAMES = 3;

/** Under "base has N new commits": whether those commits touch this branch's files. */
export function overlapText(files: readonly string[], base: string): string {
  if (files.length === 0) return `None of them touch files this branch changed.`;
  const names = files.slice(0, OVERLAP_NAMES).join(', ');
  const more = files.length > OVERLAP_NAMES ? ` and ${files.length - OVERLAP_NAMES} more` : '';
  const noun = files.length === 1 ? 'file this branch changed' : 'files this branch changed';
  return `They also change ${files.length} ${noun}: ${names}${more}. Checks here ran without ${base}'s version.`;
}
