import type { AgentDef } from '../ipc/types';

/** Detection marks a missing CLI `available: false`; custom agents carry no flag. */
export function isAgentInstalled(agent: AgentDef): boolean {
  return agent.available !== false;
}

/**
 * The agent a new task starts with: the last one used, else the first
 * installed one, so a new user is not walked into an agent that cannot
 * launch. The last one used wins even when detection misses it: it may
 * run inside a Docker image rather than on the host.
 */
export function pickDefaultAgent(agents: AgentDef[], lastAgentId: string | null): AgentDef | null {
  const last = agents.find((agent) => agent.id === lastAgentId);
  return last ?? agents.find(isAgentInstalled) ?? agents[0] ?? null;
}
