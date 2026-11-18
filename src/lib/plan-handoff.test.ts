import { describe, expect, it } from 'vitest';
import { planHandoffBlocker, planHandoffPrompt, restorePlanHandoff } from './plan-handoff';

describe('planHandoffPrompt', () => {
  it('names the plan file and includes the plan text', () => {
    expect(
      planHandoffPrompt({ content: '\n# Plan\n\n1. Do it\n', path: '.claude/plans/p.md' }),
    ).toBe(
      'Implement this approved plan. It was planned and approved in an earlier session, ' +
        'so this session starts with a clean context.\n' +
        'Plan file: .claude/plans/p.md (re-read it if you need it again).\n\n' +
        '# Plan\n\n1. Do it',
    );
  });
});

describe('planHandoffBlocker', () => {
  const ready = { planContent: '# Plan', hasTerminalAgent: true, canReopenSession: true };

  it('allows a handoff when nothing is in the way', () => {
    expect(planHandoffBlocker(ready)).toBeNull();
  });

  it('refuses without a plan', () => {
    expect(planHandoffBlocker({ ...ready, planContent: '  ' })).toBe('No plan to implement.');
  });

  it('refuses for chat-mode agents', () => {
    expect(planHandoffBlocker({ ...ready, hasTerminalAgent: false })).toBe(
      'Only available for agents running in a terminal.',
    );
  });

  // Without a way back, the planning conversation would be lost from the app.
  it('refuses for CLIs that cannot reopen a specific session', () => {
    expect(planHandoffBlocker({ ...ready, canReopenSession: false })).toBe(
      'Only available for Claude Code and Codex, whose planning session can be reopened.',
    );
  });

  // The prompt box leaves coordinated tasks' first prompts to the coordinator,
  // so a queued plan would never be sent.
  it('refuses for tasks run by a coordinating agent', () => {
    expect(planHandoffBlocker({ ...ready, coordinated: true })).toBe(
      'Not available for tasks run by a coordinating agent.',
    );
  });

  // The restart would discard what the user typed into the agent's terminal.
  it('refuses while text typed into the terminal is unsent', () => {
    expect(planHandoffBlocker({ ...ready, terminalInputPending: true })).toBe(
      'Send or clear the text typed into the agent first; the restart would discard it.',
    );
  });

  // The auto-send only fills an empty box; a draft would leave the plan unsent.
  it('refuses while the prompt box holds a draft', () => {
    expect(planHandoffBlocker({ ...ready, promptDraft: 'half typed' })).toBe(
      'Send or clear the text in the prompt box first; it would block the plan.',
    );
  });

  it('refuses while an earlier prompt is still queued', () => {
    expect(planHandoffBlocker({ ...ready, initialPrompt: 'build it' })).toBe(
      'A prompt is still waiting to be sent. Wait until it has gone out.',
    );
  });
});

describe('restorePlanHandoff', () => {
  const id = '0b6f3f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

  it('keeps a valid saved handoff', () => {
    expect(restorePlanHandoff({ sessionId: id, command: 'claude' })).toEqual({
      sessionId: id,
      command: 'claude',
    });
  });

  it('drops values it cannot resume from', () => {
    expect(restorePlanHandoff(undefined)).toBeUndefined();
    expect(restorePlanHandoff({ sessionId: 'not-a-uuid', command: 'claude' })).toBeUndefined();
    expect(restorePlanHandoff({ sessionId: id, command: '' })).toBeUndefined();
  });
});
