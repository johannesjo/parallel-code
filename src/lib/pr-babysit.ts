import type { PrChecksOverall } from '../ipc/types';

/** Fix attempts in a row before babysitting stops, so a fix that keeps failing
 *  does not loop forever. A green run resets the count. */
export const MAX_BABYSIT_ATTEMPTS = 3;

/** Per-task babysitting progress; present while babysitting is on. */
export interface PrBabysit {
  /** Failure prompts sent since CI last passed. */
  attempts: number;
  /** Head commit whose failures were last sent, so each failing commit is sent once.
   *  With several PRs, their failing heads joined by `,` (see combinedBabysitChecks). */
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

/**
 * A task's PRs summed up as one, so one Babysit covers them all: merged once
 * every PR merged, otherwise the open ones' state with running beating failed
 * beating passed. A failure's `headSha` joins the failing heads, so a push to
 * any of them is a new failure to send. Unknown until every PR has reported.
 */
export function combinedBabysitChecks(
  all: readonly (BabysitChecks | undefined)[],
): BabysitChecks | undefined {
  if (all.length === 0 || all.some((c) => c === undefined)) return undefined;
  const open = (all as BabysitChecks[]).filter((c) => !c.merged);
  if (open.length === 0) return { overall: 'none', merged: true };
  // A single PR keeps its own state, so `lastSentSha` stays a plain commit.
  if (open.length === 1 && open[0]) return open[0];
  const has = (overall: PrChecksOverall) => open.some((c) => c.overall === overall);
  if (has('pending')) return { overall: 'pending' };
  if (has('failure')) {
    const heads = open.filter((c) => c.overall === 'failure').map((c) => c.headSha);
    return heads.every(Boolean)
      ? { overall: 'failure', headSha: heads.join(',') }
      : { overall: 'failure' };
  }
  return { overall: has('success') ? 'success' : 'none' };
}

/** Every failing head in `headSha` was already sent, so nothing new failed;
 *  a PR fixed meanwhile drops out of the key without making the rest new. */
function alreadySent(headSha: string, lastSentSha: string | undefined): boolean {
  if (!lastSentSha) return false;
  const sent = new Set(lastSentSha.split(','));
  return headSha.split(',').every((head) => sent.has(head));
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
  if (alreadySent(checks.headSha, babysit.lastSentSha)) return { kind: 'wait' };
  if (babysit.attempts >= MAX_BABYSIT_ATTEMPTS) return { kind: 'give-up' };
  return { kind: 'send', headSha: checks.headSha };
}

/** CI still fails on the commit whose failures were last handled, so only a
 *  new push can move babysitting on. */
export function isAwaitingFixPush(babysit: PrBabysit, checks: BabysitChecks | undefined): boolean {
  return (
    checks?.overall === 'failure' &&
    checks.headSha !== undefined &&
    alreadySent(checks.headSha, babysit.lastSentSha)
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
  if (alreadySent(checks.headSha, babysit.lastSentSha)) return 'Waiting for a new push';
  return null;
}
