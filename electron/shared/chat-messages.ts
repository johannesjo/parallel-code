import type { AgentChatState, ChatModel } from './agent-chat-types.js';

/** The catalog entry for the model the next message would use, if it is known. */
export function selectedChatModel(state: AgentChatState): ChatModel | undefined {
  return state.models?.find((model) => model.model === state.model);
}

/** Effort the next message would use: the explicit choice, else the model's own
 *  default. The chat header and the picker must agree on this. */
export function effectiveReasoningEffort(state: AgentChatState): string | undefined {
  return state.reasoningEffort ?? selectedChatModel(state)?.defaultReasoningEffort;
}

/** Display form of a reasoning effort, which the agents report lowercase. */
export function reasoningEffortLabel(effort: string): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}
