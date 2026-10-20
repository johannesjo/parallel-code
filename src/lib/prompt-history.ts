import type { PromptHistoryEntry, Task } from '../store/types';

/** Every Enter typed into an agent terminal records a prompt, and the whole array is
 *  re-serialized on each save, so a task keeps only its most recent prompts. */
export const MAX_PROMPT_HISTORY = 100;

/** Saves made before history was recorded still carry their one last prompt. */
export function promptHistoryOf(task: Task): PromptHistoryEntry[] {
  return task.promptHistory ?? (task.lastPrompt ? [{ text: task.lastPrompt }] : []);
}

/**
 * Drop an agent's prompts once its conversation is gone, so the history only lists
 * prompts the live agents actually received. Mutates a store draft.
 */
export function forgetAgentPrompts(task: Task, agentId: string): void {
  const history = promptHistoryOf(task);
  // Untagged entries predate per-agent tagging; nearly all were sent to the main agent.
  const kept = history.filter((entry) => (entry.agentId ?? task.agentIds[0]) !== agentId);
  if (kept.length === history.length) return;
  task.promptHistory = kept.length > 0 ? kept : undefined;
  task.lastPrompt = kept.at(-1)?.text ?? '';
}
