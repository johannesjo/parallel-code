import type { Agent } from './types';

/**
 * The `signal` of an agent that was restored without being started, because
 * "Resume agents on launch" is off. It is a sentinel like `'spawn_failed'`:
 * nothing persists it, and every way of starting the agent resets `signal`.
 *
 * This lives in its own module because the agent store imports both the
 * persistence and the status module, which need it too.
 */
export const SUSPENDED_SIGNAL = 'suspended';

/** The agent has no process and waits for the user to resume it. */
export function isAgentSuspended(agent: Pick<Agent, 'status' | 'signal'> | undefined): boolean {
  return agent?.status === 'exited' && agent.signal === SUSPENDED_SIGNAL;
}
