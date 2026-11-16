import { isAgentChat } from './agent-chat';
import { getAgentHookStatus } from './agentHookStatus';
import { store } from './core';
import { getAgentOutputTail, normalizeCurrentFrame } from './taskStatus';
import type { Task } from './types';

export interface AgentMessage {
  text: string;
  /** A reply the agent ended its turn with, as opposed to a snapshot of its screen. */
  isReply: boolean;
}

/**
 * The agent's own end-of-turn message: the selected pane's chat reply or
 * hook-reported message, else the newest one, else the visible terminal screen.
 */
export function latestAgentMessage(task: Task): AgentMessage {
  const replies = new Map<string, { at: number; text: string }>();
  for (const agentId of task.agentIds) {
    if (isAgentChat(task, agentId)) {
      const reply = store.agents[agentId]?.chatState?.items.findLast(
        (item) => item.kind === 'assistant' && item.text.trim(),
      );
      // Chat items carry no time, so a hook-reported message counts as newer.
      if (reply?.kind === 'assistant') replies.set(agentId, { at: 0, text: reply.text.trim() });
      continue;
    }
    const hook = getAgentHookStatus(agentId);
    const text = hook?.lastAssistantMessage?.trim();
    if (hook && text) replies.set(agentId, { at: hook.updatedAt, text });
  }
  const selected = task.selectedAgentId ? replies.get(task.selectedAgentId) : undefined;
  const newest = [...replies.values()].reduce<{ at: number; text: string } | undefined>(
    (best, reply) => (!best || reply.at > best.at ? reply : best),
    undefined,
  );
  const reply = selected ?? newest;
  if (reply) return { text: reply.text, isReply: true };
  const agentId = task.agentIds.find((id) => !isAgentChat(task, id));
  return {
    text: agentId ? normalizeCurrentFrame(getAgentOutputTail(agentId)) : '',
    isReply: false,
  };
}
