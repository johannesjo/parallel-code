import { describe, expect, it } from 'vitest';
import { isStalled, promptDelivery, PROMPT_STALL_MS, START_CONFIRM_MS } from './prompt-delivery.js';

const base = { now: 100_000, blockedBy: 'agent_startup' as const, awaitingInput: true };

describe('promptDelivery', () => {
  it('reports a queued prompt with its blocker and age', () => {
    expect(promptDelivery({ ...base, queuedAt: 40_000, blockedBy: 'user_activity' })).toEqual({
      state: 'queued',
      blockedBy: 'user_activity',
      sinceMs: 60_000,
    });
  });

  it('reports a submitted prompt the agent never started as unconfirmed', () => {
    expect(promptDelivery({ ...base, submittedAt: base.now - START_CONFIRM_MS })).toEqual({
      state: 'unconfirmed',
      sinceMs: START_CONFIRM_MS,
    });
  });

  it('stays silent while the agent may still be starting its turn', () => {
    expect(promptDelivery({ ...base, submittedAt: base.now - 1_000 })).toBeUndefined();
  });

  it('stays silent once the agent started or left the empty prompt', () => {
    const submittedAt = base.now - 2 * START_CONFIRM_MS;
    expect(promptDelivery({ ...base, submittedAt, startedAt: submittedAt + 1 })).toBeUndefined();
    expect(promptDelivery({ ...base, submittedAt, awaitingInput: false })).toBeUndefined();
  });
});

describe('isStalled', () => {
  const old = PROMPT_STALL_MS;

  it('flags old startup and user-activity blocks and unconfirmed prompts', () => {
    expect(isStalled({ state: 'queued', blockedBy: 'agent_startup', sinceMs: old }, false)).toBe(
      true,
    );
    expect(isStalled({ state: 'queued', blockedBy: 'user_activity', sinceMs: old }, false)).toBe(
      true,
    );
    expect(isStalled({ state: 'unconfirmed', sinceMs: old }, true)).toBe(true);
  });

  it('does not flag a follow-up waiting behind a working agent', () => {
    expect(isStalled({ state: 'queued', blockedBy: 'agent_busy', sinceMs: old }, false)).toBe(
      false,
    );
    expect(isStalled({ state: 'queued', blockedBy: 'agent_busy', sinceMs: old }, true)).toBe(true);
  });

  it('does not flag recent prompts', () => {
    expect(
      isStalled({ state: 'queued', blockedBy: 'agent_startup', sinceMs: old - 1 }, false),
    ).toBe(false);
    expect(isStalled(undefined, true)).toBe(false);
  });
});
