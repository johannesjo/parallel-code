import { error as logError } from '../log.js';
import type { AgentHookEventPayload } from './status.js';

type AgentHookListener = (event: AgentHookEventPayload) => void;

const listeners = new Set<AgentHookListener>();

/**
 * Subscribe a main-process consumer (the MCP coordinator) to every hook event
 * the server accepts. The renderer gets the same events over IPC; this is the
 * in-process side of that fan-out. Returns the unsubscribe.
 */
export function onAgentHookEvent(listener: AgentHookListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** One throwing listener must not starve the others or the renderer forward. */
export function emitAgentHookEvent(event: AgentHookEventPayload): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      logError('agent-hooks', 'hook event listener threw', err);
    }
  }
}
