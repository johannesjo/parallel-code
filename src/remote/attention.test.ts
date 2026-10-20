import { describe, it, expect } from 'vitest';
import { agentStatusDisplay, needsYou } from './attention';
import type { RemoteAttentionState } from '../../electron/remote/protocol';

describe('agentStatusDisplay', () => {
  it('maps each attention state to a label', () => {
    const expected: Record<RemoteAttentionState, string> = {
      needs_input: 'Needs input',
      active: 'Working',
      shell_busy: 'Terminal busy',
      error: 'Error',
      review: 'Review',
      ready: 'Ready',
      idle: 'Idle',
    };
    for (const [attention, label] of Object.entries(expected)) {
      const d = agentStatusDisplay({
        status: 'running',
        attention: attention as RemoteAttentionState,
      });
      expect(d.label).toBe(label);
      expect(d.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('glows the attention-worthy states only', () => {
    const glowing: RemoteAttentionState[] = ['needs_input', 'active', 'error', 'review'];
    const calm: RemoteAttentionState[] = ['ready', 'idle', 'shell_busy'];
    for (const a of glowing) {
      expect(agentStatusDisplay({ status: 'running', attention: a }).glow).toBe(true);
    }
    for (const a of calm) {
      expect(agentStatusDisplay({ status: 'running', attention: a }).glow).toBe(false);
    }
  });

  it('distinguishes an exited idle agent from a live one', () => {
    expect(agentStatusDisplay({ status: 'running', attention: 'idle' }).label).toBe('Idle');
    expect(agentStatusDisplay({ status: 'exited', attention: 'idle' }).label).toBe('Exited');
  });

  it('lets a non-idle attention win over an exited process', () => {
    // An errored task that also exited should read as "Error", not "Exited".
    expect(agentStatusDisplay({ status: 'exited', attention: 'error' }).label).toBe('Error');
  });

  it('names a ready task by its PR checks', () => {
    const ready = { status: 'running', attention: 'ready' } as const;
    expect(agentStatusDisplay({ ...ready, ci: 'success' }).label).toBe('Ready to merge');
    expect(agentStatusDisplay({ ...ready, ci: 'pending' }).label).toBe('CI running');
    expect(agentStatusDisplay(ready).label).toBe('Ready');
  });

  it('flags failed CI on a settled task, but not over a busier state', () => {
    const failed = agentStatusDisplay({ status: 'running', attention: 'idle', ci: 'failure' });
    expect(failed).toMatchObject({ label: 'CI failed', glow: true });
    expect(
      agentStatusDisplay({ status: 'running', attention: 'active', ci: 'failure' }).label,
    ).toBe('Working');
    expect(
      agentStatusDisplay({ status: 'running', attention: 'idle', ci: 'failure', collapsed: true })
        .label,
    ).toBe('Minimized');
  });
});

describe('needsYou', () => {
  it('counts questions, errors and failed CI on a settled task', () => {
    expect(needsYou({ attention: 'needs_input' })).toBe(true);
    expect(needsYou({ attention: 'error' })).toBe(true);
    expect(needsYou({ attention: 'idle', ci: 'failure' })).toBe(true);
    expect(needsYou({ attention: 'active', ci: 'failure' })).toBe(false);
    expect(needsYou({ attention: 'ready', ci: 'pending' })).toBe(false);
  });
});
