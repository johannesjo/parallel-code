// The Coordinator's state as the function modules in this directory see it, and
// the helpers several of them need.

import { getActiveAgentIds, getAgentMeta } from '../../ipc/pty.js';
import type { CoordinatedTask } from '../types.js';
import { IPC } from '../../ipc/channels.js';
import type { Notify } from '../../ipc/notify.js';
import type { CoordinatorState } from '../types.js';
import type { SessionMcpProvider } from './mcp-config.js';
import type { CoordinatorNotifications } from './notifications.js';
import type { CoordinatorLanding } from './landing.js';
import type { CoordinatorPrompts } from './prompts.js';
import type { SignalWaits } from './signal-waits.js';

/** Why a waitForIdle caller was released. */
type IdleWaitResult = { reason: 'idle' | 'human_control' | 'exited' | 'removed' };

/**
 * State the Coordinator owns, as the function modules in this directory see it.
 * Their functions take it as the first argument; the class in ../coordinator.ts
 * holds the fields (and the comments explaining each) and passes itself.
 */
export interface CoordinatorInternals {
  tasks: Map<string, CoordinatedTask>;
  tailBuffers: Map<string, string>;
  idleResolvers: Map<string, Array<(result: IdleWaitResult) => void>>;
  subscribers: Map<string, (encoded: string) => void>;
  decoders: Map<string, TextDecoder>;
  controlMap: Map<string, 'coordinator' | 'human'>;
  promptReadySeenAt: Map<string, number>;
  bracketedPasteAgentIds: Set<string>;
  closingTaskIds: Set<string>;
  cleanupsInFlight: Map<string, Promise<void>>;
  integratingTaskIds: Set<string>;
  orchestrationEnabled: boolean;
  orchestrationEpoch: number;
  sessionMcpProvider?: SessionMcpProvider;
  hookLiveAgentIds: Set<string>;
  interruptedAt: Map<string, number>;
  pendingCreateCounts: Map<string, number>;
  notify: Notify | null;
  projectRoot: string | null;
  projectId: string | null;
  defaultCoordinatorTaskId: string | null;
  coordinators: Map<string, CoordinatorState>;
  preambleWriteQueue: Map<string, Promise<void>>;
  notifications: CoordinatorNotifications;
  landing: CoordinatorLanding;
  prompts: CoordinatorPrompts;
  signalWaits: SignalWaits;
}

export function assertOrchestrationEnabled(
  c: CoordinatorInternals,
  epoch = c.orchestrationEpoch,
): void {
  if (!c.orchestrationEnabled || epoch !== c.orchestrationEpoch) {
    throw new Error(
      'Agent orchestration is disabled or this operation was canceled. Enable it in Settings > Agents to start new operations.',
    );
  }
}

export function findTaskByAgentId(
  c: CoordinatorInternals,
  agentId: string,
): CoordinatedTask | undefined {
  for (const task of c.tasks.values()) {
    if (task.agentId === agentId) return task;
  }
  return undefined;
}

export function agentIdsForTask(task: CoordinatedTask): string[] {
  return [
    ...new Set([
      task.agentId,
      ...getActiveAgentIds().filter((agentId) => getAgentMeta(agentId)?.taskId === task.id),
    ]),
  ];
}

/** Resolve any pending waitForIdle callers for a task and clear the entry. */
export function resolveIdleWaiters(
  c: CoordinatorInternals,
  taskId: string,
  reason: 'idle' | 'human_control' | 'exited' | 'removed',
): void {
  const resolvers = c.idleResolvers.get(taskId);
  if (resolvers?.length) {
    for (const resolve of resolvers) resolve({ reason });
  }
  c.idleResolvers.delete(taskId);
}

export function withdrawCloseSuggestion(c: CoordinatorInternals, task: CoordinatedTask): void {
  if (!task.closeSuggestion) return;
  task.closeSuggestion = undefined;
  notifyRenderer(c, IPC.MCP_TaskStateSync, { taskId: task.id, closeSuggestion: null });
}

export function advanceReviewRevision(c: CoordinatorInternals, task: CoordinatedTask): number {
  task.reviewRevision = (task.reviewRevision ?? 0) + 1;
  notifyRenderer(c, IPC.MCP_TaskStateSync, {
    taskId: task.id,
    reviewRevision: task.reviewRevision,
  });
  return task.reviewRevision;
}

/** A close or integration under way supersedes archiving and completions. */
export function isClosingOrIntegrating(c: CoordinatorInternals, taskId: string): boolean {
  return c.closingTaskIds.has(taskId) || c.integratingTaskIds.has(taskId);
}

export function notifyRenderer(c: CoordinatorInternals, channel: string, data: unknown): void {
  c.notify?.(channel, data);
}
