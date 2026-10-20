import { error as logError } from '../log.js';
import {
  activityEvidenceFromHook,
  transitionAgentHookStatus,
  type ActivityEvidence,
  type AgentActivityObservation,
  type AgentActivitySnapshot,
  type AgentHookEventPayload,
  type ReducedAgentHookStatus,
} from './status.js';

interface LiveObservation {
  observation: AgentActivityObservation;
  status?: ReducedAgentHookStatus;
}

// One entry per live PTY, never a history of retired launches or hook events.
const live = new Map<string, LiveObservation>();
let sequence = 0;
const listeners = new Set<(observation: AgentActivityObservation) => void>();

function publish(observation: AgentActivityObservation): void {
  for (const listener of listeners) {
    try {
      listener(observation);
    } catch (err) {
      logError('agent-hooks', 'activity observation listener threw', err);
    }
  }
}

export function onAgentActivityObservation(
  listener: (observation: AgentActivityObservation) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function registerAgentLaunch(agentId: string, taskId: string, launchId: string): void {
  const observation: AgentActivityObservation = {
    kind: 'launch',
    agentId,
    taskId,
    launchId,
    sequence: ++sequence,
    at: Date.now(),
  };
  live.set(agentId, { observation });
  publish(observation);
}

export function isCurrentAgentLaunch(agentId: string, taskId: string, launchId: string): boolean {
  const current = live.get(agentId)?.observation;
  return !!launchId && current?.launchId === launchId && current.taskId === taskId;
}

/** An old process exit must never retire its same-ID replacement. */
export function retireAgentLaunch(agentId: string, launchId: string): void {
  const current = live.get(agentId)?.observation;
  if (current?.launchId !== launchId) return;
  live.delete(agentId);
  publish({
    kind: 'retired',
    agentId,
    taskId: current.taskId,
    launchId,
    sequence: ++sequence,
    at: Date.now(),
  });
}

/** Input submission invalidates a finished-turn fact without claiming hook activity. */
export function invalidateAgentActivity(agentId: string, launchId: string): void {
  const current = live.get(agentId);
  if (current?.observation.launchId !== launchId || current.status?.state !== 'done') return;
  const observation: AgentActivityObservation = {
    kind: 'invalidated',
    agentId,
    taskId: current.observation.taskId,
    launchId,
    sequence: ++sequence,
    at: Date.now(),
  };
  live.set(agentId, { observation });
  publish(observation);
}

export function observeAgentHook(
  event: AgentHookEventPayload,
): AgentActivityObservation | undefined {
  if (!event.launchId || !isCurrentAgentLaunch(event.agentId, event.taskId, event.launchId)) return;
  const previous = live.get(event.agentId);
  const status = transitionAgentHookStatus(previous?.status, event);
  if (status === previous?.status) return;
  const observation: AgentActivityObservation = {
    ...event,
    ...status,
    kind: 'hook',
    launchId: event.launchId,
    sequence: ++sequence,
    at: status.updatedAt,
  };
  live.set(event.agentId, { observation, status });
  publish(observation);
  return observation;
}

export function getAgentActivitySnapshot(): AgentActivitySnapshot {
  return {
    sequence,
    observations: [...live.values()].map(({ observation }) => ({ ...observation })),
  };
}

export function getAgentActivityEvidence(
  agentId: string,
  now = Date.now(),
): ActivityEvidence | undefined {
  const current = live.get(agentId);
  if (!current) return;
  if (current.status)
    return activityEvidenceFromHook(agentId, current.observation.launchId, current.status, now);
  return {
    agentId,
    launchId: current.observation.launchId,
    source: 'process',
    activity: 'unknown',
    event: current.observation.kind === 'invalidated' ? 'PromptSubmitted' : 'ProcessStarted',
    freshness: 'unknown',
  };
}
