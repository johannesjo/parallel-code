import { createSignal } from 'solid-js';

/** The last report an agent published through MCP; lets the panel show a live map without activation. */
export interface AgentPublication {
  taskId: string;
  agentId: string;
  generation: number;
}

const [agentPublications, setAgentPublications] = createSignal<Record<string, AgentPublication>>(
  {},
);

/** The last publication for `taskId`; each task keeps its own so a hidden panel misses nothing. */
export function agentPublication(taskId: string): AgentPublication | undefined {
  return agentPublications()[taskId];
}

export function recordAgentPublication(publication: AgentPublication): void {
  setAgentPublications((previous) => ({ ...previous, [publication.taskId]: publication }));
}

/** Called when a task is removed so the record does not outlive it. */
export function forgetAgentPublication(taskId: string): void {
  setAgentPublications(({ [taskId]: _removed, ...rest }) => rest);
}

/** Bumped after this renderer writes to a task's feed, so visible panes re-read at once. */
const [reasoningFeedChange, setReasoningFeedChange] = createSignal<{
  taskId: string;
  serial: number;
}>();

export { reasoningFeedChange };

export function notifyReasoningFeedChanged(taskId: string): void {
  setReasoningFeedChange((previous) => ({ taskId, serial: (previous?.serial ?? 0) + 1 }));
}
