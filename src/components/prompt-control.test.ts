import { describe, expect, it } from 'vitest';
import {
  resolveAutoSendVerifyOutcome,
  shouldAcceptMissingInitialPromptEcho,
  shouldAckInitialPromptDelivery,
  shouldHandoffCoordinatorQuestion,
  shouldRendererAutoSendInitialPrompt,
} from './prompt-control';

const handoffDefaults = {
  controlledBy: 'coordinator' as const,
  questionActive: true,
  agentIdle: true,
  startupBlocking: false,
  autoTrustSettling: false,
  autoTrustHandled: false,
  recentPromptEcho: false,
};

describe('shouldHandoffCoordinatorQuestion', () => {
  it('hands off when a coordinator-controlled task is asking a question', () => {
    expect(shouldHandoffCoordinatorQuestion(handoffDefaults)).toBe(true);
  });

  it('does not hand off when already under human control', () => {
    expect(shouldHandoffCoordinatorQuestion({ ...handoffDefaults, controlledBy: 'human' })).toBe(
      false,
    );
  });

  it('does not hand off when no question is active', () => {
    expect(shouldHandoffCoordinatorQuestion({ ...handoffDefaults, questionActive: false })).toBe(
      false,
    );
  });

  it('does not hand off when controlledBy is undefined even if questionActive is true', () => {
    expect(shouldHandoffCoordinatorQuestion({ ...handoffDefaults, controlledBy: undefined })).toBe(
      false,
    );
  });

  it('does not hand off while startup output is still blocking auto-send', () => {
    expect(shouldHandoffCoordinatorQuestion({ ...handoffDefaults, startupBlocking: true })).toBe(
      false,
    );
  });

  it('does not hand off while auto-trust is still settling', () => {
    expect(shouldHandoffCoordinatorQuestion({ ...handoffDefaults, autoTrustSettling: true })).toBe(
      false,
    );
  });

  it('does not hand off when auto-trust will handle the question', () => {
    expect(shouldHandoffCoordinatorQuestion({ ...handoffDefaults, autoTrustHandled: true })).toBe(
      false,
    );
  });

  it('does not hand off while the agent is actively producing output', () => {
    expect(shouldHandoffCoordinatorQuestion({ ...handoffDefaults, agentIdle: false })).toBe(false);
  });

  it('does not hand off when the question-like text is from a recent prompt echo', () => {
    expect(shouldHandoffCoordinatorQuestion({ ...handoffDefaults, recentPromptEcho: true })).toBe(
      false,
    );
  });
});

describe('shouldAckInitialPromptDelivery', () => {
  it('acks an exact coordinated initial-prompt send', () => {
    expect(
      shouldAckInitialPromptDelivery({
        coordinatedBy: 'coordinator-1',
        initialPrompt: 'do the work',
        sentText: 'do the work',
      }),
    ).toBe(true);
  });

  it('uses the pre-send initial prompt snapshot, not later prop state', () => {
    expect(
      shouldAckInitialPromptDelivery({
        coordinatedBy: 'coordinator-1',
        initialPrompt: undefined,
        sentText: 'do the work',
      }),
    ).toBe(false);
  });

  it('does not ack edited or non-coordinated sends', () => {
    expect(
      shouldAckInitialPromptDelivery({
        coordinatedBy: 'coordinator-1',
        initialPrompt: 'do the work',
        sentText: 'different work',
      }),
    ).toBe(false);
    expect(
      shouldAckInitialPromptDelivery({
        coordinatedBy: undefined,
        initialPrompt: 'do the work',
        sentText: 'do the work',
      }),
    ).toBe(false);
  });
});

describe('shouldRendererAutoSendInitialPrompt', () => {
  it('keeps legacy/manual initial prompts renderer-owned', () => {
    expect(
      shouldRendererAutoSendInitialPrompt({
        coordinatedBy: undefined,
        initialPrompt: 'do the work',
      }),
    ).toBe(true);
  });

  it('does not renderer-send coordinated sub-task assignments', () => {
    expect(
      shouldRendererAutoSendInitialPrompt({
        coordinatedBy: 'coord-1',
        initialPrompt: 'do the work',
      }),
    ).toBe(false);
  });

  it('does not send blank initial prompts', () => {
    expect(
      shouldRendererAutoSendInitialPrompt({
        coordinatedBy: undefined,
        initialPrompt: '   ',
      }),
    ).toBe(false);
  });
});

describe('resolveAutoSendVerifyOutcome', () => {
  const base = { appeared: false, aborted: false, retryCount: 0, maxRetries: 2 };

  it('delivers when the echo appeared', () => {
    expect(resolveAutoSendVerifyOutcome({ ...base, appeared: true })).toBe('deliver');
  });

  it('delivers an accepted compacted prompt when its textual echo is missing', () => {
    expect(resolveAutoSendVerifyOutcome({ ...base, acceptMissingEcho: true })).toBe('deliver');
  });

  it('retries when the echo is missing and retries remain', () => {
    expect(resolveAutoSendVerifyOutcome({ ...base, retryCount: 0 })).toBe('retry');
    expect(resolveAutoSendVerifyOutcome({ ...base, retryCount: 1 })).toBe('retry');
  });

  it('gives up when the echo is missing and retries are exhausted', () => {
    expect(resolveAutoSendVerifyOutcome({ ...base, retryCount: 2 })).toBe('giveup');
    expect(resolveAutoSendVerifyOutcome({ ...base, retryCount: 3 })).toBe('giveup');
  });

  it('reports aborted regardless of retry budget', () => {
    expect(resolveAutoSendVerifyOutcome({ ...base, aborted: true, retryCount: 0 })).toBe('aborted');
    expect(resolveAutoSendVerifyOutcome({ ...base, aborted: true, retryCount: 5 })).toBe('aborted');
  });

  it('lets abort win over a late echo so a superseded send is not delivered', () => {
    expect(resolveAutoSendVerifyOutcome({ ...base, appeared: true, aborted: true })).toBe(
      'aborted',
    );
  });

  it('lets abort win over accepted missing echoes', () => {
    expect(resolveAutoSendVerifyOutcome({ ...base, aborted: true, acceptMissingEcho: true })).toBe(
      'aborted',
    );
  });
});

describe('shouldAcceptMissingInitialPromptEcho', () => {
  it('accepts a coordinator prompt whose large paste was compacted by the agent TUI', () => {
    expect(
      shouldAcceptMissingInitialPromptEcho({
        coordinatorMode: true,
        initialPrompt: '[COORDINATOR MODE] coordinate these tasks',
      }),
    ).toBe(true);
  });

  it('keeps echo verification for ordinary initial prompts', () => {
    expect(
      shouldAcceptMissingInitialPromptEcho({
        coordinatorMode: false,
        initialPrompt: 'implement the feature',
      }),
    ).toBe(false);
    expect(
      shouldAcceptMissingInitialPromptEcho({
        coordinatorMode: true,
        initialPrompt: 'implement the feature',
      }),
    ).toBe(false);
  });
});
