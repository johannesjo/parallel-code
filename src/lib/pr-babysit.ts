import type { PrChecksOverall } from '../ipc/types';

/** Fix attempts in a row before babysitting stops, so a fix that keeps failing
 *  does not loop forever. A green run resets the count. */
export const MAX_BABYSIT_ATTEMPTS = 3;

/** Per-task babysitting progress; present while babysitting is on. */
export interface PrBabysit {
  /** Failure prompts sent since CI last passed. */
  attempts: number;
  /** Head commit whose failures were last sent, so each failing commit is sent once. */
  lastSentSha?: string;
  /** CI still fails on `lastSentSha` and nobody is pushing a fix, often because
   *  the agent could not run a command it needed; the failure is the user's. */
  stalled?: true;
}

/** The parts of a PR's checks state that babysitting reacts to. */
export interface BabysitChecks {
  overall: PrChecksOverall;
  headSha?: string;
  merged?: boolean;
}

export type BabysitStep =
  | { kind: 'wait' }
  | { kind: 'send'; headSha: string }
  | { kind: 'reset' }
  | { kind: 'give-up' }
  | { kind: 'done' };

/** What babysitting should do after a PR's latest checks update. */
export function nextBabysitStep(
  babysit: PrBabysit,
  checks: BabysitChecks | undefined,
): BabysitStep {
  if (!checks) return { kind: 'wait' };
  if (checks.merged) return { kind: 'done' };
  if (checks.overall === 'success')
    return babysit.attempts > 0 ? { kind: 'reset' } : { kind: 'wait' };
  // Pending wins over failed in the summary, so this waits for the whole run
  // and sends its failures together.
  if (checks.overall !== 'failure' || !checks.headSha) return { kind: 'wait' };
  if (checks.headSha === babysit.lastSentSha) return { kind: 'wait' };
  if (babysit.attempts >= MAX_BABYSIT_ATTEMPTS) return { kind: 'give-up' };
  return { kind: 'send', headSha: checks.headSha };
}

/** CI still fails on the commit whose failures were last handled, so only a
 *  new push can move babysitting on. */
export function isAwaitingFixPush(babysit: PrBabysit, checks: BabysitChecks | undefined): boolean {
  return (
    checks?.overall === 'failure' &&
    checks.headSha !== undefined &&
    checks.headSha === babysit.lastSentSha
  );
}

/** Why babysitting is waiting on CI itself, as shown on its toggle; null when
 *  CI has a failure to send and only the agent's readiness decides. */
export function babysitCiWaitReason(
  babysit: PrBabysit,
  checks: BabysitChecks | undefined,
): string | null {
  if (!checks) return 'Waiting for the PR checks to load';
  if (checks.overall === 'pending') return 'Waiting for CI to finish';
  if (checks.overall === 'none') return 'Waiting for CI checks to start';
  if (checks.overall === 'success') return 'CI is passing';
  if (!checks.headSha) return 'Waiting for the PR checks to load';
  if (checks.headSha === babysit.lastSentSha) return 'Waiting for a new push';
  return null;
}
