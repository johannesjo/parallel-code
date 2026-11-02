import { describe, expect, it } from 'vitest';
import {
  MAX_BABYSIT_ATTEMPTS,
  babysitCiWaitReason,
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
