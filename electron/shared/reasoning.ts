import { GRAPH_ID_REGEX } from './graph-limits.js';

export const REASONING_MAX_BYTES = 1024 * 1024;
/** Updates one run may hold before the agent must start a new one. */
export const REASONING_MAX_UPDATES = 1000;

export interface ReasoningDocument {
  runId: string | null;
  revision: number;
  workflow: string;
  /** Reporting guidance keyed by workflow name; `workflow` names the task's current choice. */
  workflows?: Record<string, string>;
  graph: import('./reasoning-state.js').Snapshot | null;
  warning?: string;
}

/** A feed read: `unchanged` when the caller's stamp still matches, else the full text. */
export type ReasoningFeedRead =
  | { unchanged: true; stamp: string }
  | { unchanged?: false; raw: string; stamp: string };

/** Separate feeds even when two tasks share a checkout or run multiple agents. */
export function reasoningFeedPath(taskId: string, agentId: string): string {
  for (const id of [taskId, agentId]) {
    if (!GRAPH_ID_REGEX.test(id)) throw new Error('Invalid reasoning task or agent ID');
  }
  return `.parallel-code/reasoning/${taskId}/${agentId}.jsonl`;
}
