import { describe, it, expect } from 'vitest';
import { agentStatusDisplay } from './attention';
import type { RemoteAttentionState } from '../../electron/remote/protocol';

describe('agentStatusDisplay', () => {
  it('maps each attention state to a label', () => {
    const expected: Record<RemoteAttentionState, string> = {
      needs_input: 'Needs input',
      active: 'Working',
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
    const calm: RemoteAttentionState[] = ['ready', 'idle'];
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
});
