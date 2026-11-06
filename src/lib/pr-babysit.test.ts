import { describe, expect, it } from 'vitest';
import {
  MAX_BABYSIT_ATTEMPTS,
  babysitCiWaitReason,
  combinedBabysitChecks,
  isAwaitingFixPush,
  nextBabysitStep,
  type BabysitChecks,
} from './pr-babysit';

const failed = (headSha: string): BabysitChecks => ({ overall: 'failure', headSha });

describe('nextBabysitStep', () => {
  it('sends a failing commit the agent has not seen yet', () => {
    expect(nextBabysitStep({ attempts: 0 }, failed('a'))).toEqual({ kind: 'send', headSha: 'a' });
  });

  it('sends each failing commit only once', () => {
    expect(nextBabysitStep({ attempts: 1, lastSentSha: 'a' }, failed('a'))).toEqual({
      kind: 'wait',
    });
    expect(nextBabysitStep({ attempts: 1, lastSentSha: 'a' }, failed('b'))).toEqual({
      kind: 'send',
      headSha: 'b',
    });
  });

  it('does not resend a PR whose failure was sent when another PR got fixed', () => {
    const babysit = { attempts: 1, lastSentSha: 'a,b' };
    expect(nextBabysitStep(babysit, failed('a'))).toEqual({ kind: 'wait' });
    expect(isAwaitingFixPush(babysit, failed('a'))).toBe(true);
    expect(babysitCiWaitReason(babysit, failed('a'))).toBe('Waiting for a new push');
    expect(nextBabysitStep(babysit, failed('a,c'))).toEqual({ kind: 'send', headSha: 'a,c' });
  });

  it('gives up on a new failure once every attempt is used', () => {
    const babysit = { attempts: MAX_BABYSIT_ATTEMPTS, lastSentSha: 'c' };
    expect(nextBabysitStep(babysit, failed('d'))).toEqual({ kind: 'give-up' });
  });

  it('waits while checks run, even if some already failed', () => {
    expect(nextBabysitStep({ attempts: 0 }, { overall: 'pending', headSha: 'a' })).toEqual({
      kind: 'wait',
    });
  });

  it('waits until the failing commit is known', () => {
    expect(nextBabysitStep({ attempts: 0 }, { overall: 'failure' })).toEqual({ kind: 'wait' });
    expect(nextBabysitStep({ attempts: 0 }, undefined)).toEqual({ kind: 'wait' });
  });

  it('resets the attempt count when CI passes', () => {
    const success: BabysitChecks = { overall: 'success', headSha: 'b' };
    expect(nextBabysitStep({ attempts: 2, lastSentSha: 'a' }, success)).toEqual({ kind: 'reset' });
    expect(nextBabysitStep({ attempts: 0 }, success)).toEqual({ kind: 'wait' });
  });

  it('finishes once the PR is merged', () => {
    expect(
      nextBabysitStep({ attempts: 1 }, { overall: 'failure', headSha: 'a', merged: true }),
    ).toEqual({ kind: 'done' });
  });
});

describe('babysitCiWaitReason', () => {
  it('names what CI is still doing', () => {
    expect(babysitCiWaitReason({ attempts: 0 }, undefined)).toBe(
      'Waiting for the PR checks to load',
    );
    expect(babysitCiWaitReason({ attempts: 0 }, { overall: 'pending', headSha: 'a' })).toBe(
      'Waiting for CI to finish',
    );
    expect(babysitCiWaitReason({ attempts: 0 }, { overall: 'success', headSha: 'a' })).toBe(
      'CI is passing',
    );
  });

  it('waits for a push once a failing commit was handled', () => {
    expect(babysitCiWaitReason({ attempts: 1, lastSentSha: 'a' }, failed('a'))).toBe(
      'Waiting for a new push',
    );
  });

  it('leaves a new failure to the agent check', () => {
    expect(babysitCiWaitReason({ attempts: 1, lastSentSha: 'a' }, failed('b'))).toBeNull();
  });
});

describe('combinedBabysitChecks', () => {
  const passed = (headSha: string): BabysitChecks => ({ overall: 'success', headSha });
  const merged: BabysitChecks = { overall: 'none', merged: true };

  it('keeps a single PR as it is', () => {
    expect(combinedBabysitChecks([failed('a')])).toEqual({ overall: 'failure', headSha: 'a' });
  });

  it('fails when any open PR fails, keyed by the failing heads', () => {
    expect(combinedBabysitChecks([passed('a'), failed('b'), failed('c')])).toEqual({
      overall: 'failure',
      headSha: 'b,c',
    });
  });

  it('waits for a running PR before sending failures of another', () => {
    expect(combinedBabysitChecks([failed('a'), { overall: 'pending', headSha: 'b' }])).toEqual({
      overall: 'pending',
    });
  });

  it('ignores merged PRs and passes once the open ones pass', () => {
    expect(combinedBabysitChecks([merged, passed('a'), passed('b')])).toEqual({
      overall: 'success',
    });
  });

  it('is merged only once every PR merged', () => {
    expect(combinedBabysitChecks([merged, merged])).toEqual(merged);
  });

  it('is unknown until every PR has reported', () => {
    expect(combinedBabysitChecks([failed('a'), undefined])).toBeUndefined();
    expect(combinedBabysitChecks([])).toBeUndefined();
  });
});
