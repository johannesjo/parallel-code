import { afterEach, describe, expect, it } from 'vitest';
import { setStore } from './core';
import { agentChatUnavailableReason, isAgentChat, reopenClaudeChatInTerminal } from './agent-chat';
import type { Agent, Task } from './types';

function withAgent(defId: string, view?: 'chat'): Task {
  setStore('agents', 'agent-1', { id: 'agent-1', def: { id: defId } } as unknown as Agent);
  return { id: 'task-1', agentIds: ['agent-1'], mainAgentView: view } as unknown as Task;
}

describe('turning Claude chat off', () => {
  afterEach(() => {
    setStore('disableClaudeUiMode', false);
    setStore('agents', {});
  });

  it('keeps Claude tasks from entering chat, and leaves Codex alone', () => {
    setStore('disableClaudeUiMode', true);
    expect(agentChatUnavailableReason(withAgent('claude-code'))).toMatch(/turned off/);
    expect(agentChatUnavailableReason(withAgent('codex'))).toBe('');
  });

  it('keeps a chat that is already open, so switching to the terminal hands it over', () => {
    setStore('disableClaudeUiMode', true);
    const task = withAgent('claude-code', 'chat');
    expect(agentChatUnavailableReason(task)).toBe('');
    expect(isAgentChat(task, 'agent-1')).toBe(true);
  });

  it('reopens a restored Claude chat in the terminal on its session', () => {
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const task = { ...withAgent('claude-code', 'chat'), claudeChatSessionId: sessionId };
    reopenClaudeChatInTerminal(task, 'codex', true);
    expect(task.mainAgentView).toBe('chat');
    reopenClaudeChatInTerminal(task, 'claude-code', false);
    expect(task.mainAgentView).toBe('chat');
    reopenClaudeChatInTerminal(task, 'claude-code', true);
    expect(task.mainAgentView).toBeUndefined();
    expect(task.agentSessionIds).toEqual({ 'agent-1': sessionId });
  });
});
