import { isSessionId } from '../../electron/shared/session-record';
import { store } from './core';
import type { Task } from './types';

export function agentChatProvider(agentId: string): 'codex' | 'claude' | undefined {
  const id = store.agents[agentId]?.def.id;
  return id === 'codex' ? 'codex' : id === 'claude-code' ? 'claude' : undefined;
}

export function agentChatUnavailableReason(task: Task): string {
  // A chat already open stays one until the user switches it to the terminal:
  // that switch is what shuts the chat's CLI down and hands its session over.
  if (
    store.disableClaudeUiMode &&
    task.mainAgentView !== 'chat' &&
    agentChatProvider(task.agentIds[0]) === 'claude'
  )
    return 'Chat is turned off for Claude Code in Settings';
  if (task.dockerMode) return 'Chat is not available for Docker tasks yet';
  if (task.coordinatorMode || task.coordinatedBy)
    return 'Chat is not available for coordinator tasks or subtasks yet';
  return '';
}

export function supportsAgentChat(task: Task): boolean {
  return !!agentChatProvider(task.agentIds[0]) && !agentChatUnavailableReason(task);
}

export function isAgentChat(task: Task | undefined, agentId: string): boolean {
  return (
    !!task &&
    task.mainAgentView === 'chat' &&
    task.agentIds[0] === agentId &&
    supportsAgentChat(task)
  );
}

/** The task's composer is the chat view, so the terminal prompt is not the one on screen. */
export function taskUsesAgentChat(task: Task | undefined): boolean {
  return !!task && isAgentChat(task, task.agentIds[0]);
}

/**
 * With Claude's chat turned off, a Claude task coming back from disk or from
 * the collapsed list in the chat view reopens in the terminal on the same
 * conversation: what a view switch does, minus quitting a chat, as none runs
 * yet. Mutates `task`, so call it inside a store `produce` or before storing.
 */
export function reopenClaudeChatInTerminal(
  task: Task,
  agentDefId: string | undefined,
  chatDisabled: boolean,
): void {
  if (!chatDisabled || agentDefId !== 'claude-code') return;
  if (task.mainAgentView !== 'chat') return;
  task.mainAgentView = undefined;
  const agentId = task.agentIds[0];
  const sessionId = task.claudeChatSessionId;
  if (agentId && isSessionId(sessionId)) {
    task.agentSessionIds = { ...task.agentSessionIds, [agentId]: sessionId };
  }
}
