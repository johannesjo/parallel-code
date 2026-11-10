// Whether a parent may start or restart a child: its concurrency limit, and
// stopping and resuming all of its children.

import type { CoordinatorInternals } from './internals.js';
import { killAgent, getActiveAgentIds, getAgentMeta } from '../../ipc/pty.js';
import {
  clampCoordinatorConcurrentTasks,
  DEFAULT_COORDINATOR_CONCURRENT_TASKS,
} from '../../shared/coordinator-limits.js';
import type { CoordinatedTask, CoordinatorState } from '../types.js';
import { agentIdsForTask } from './internals.js';

export function assertParentAdmission(
  c: CoordinatorInternals,
  parentId: string,
  epoch?: number,
): CoordinatorState {
  const parent = c.coordinators.get(parentId);
  if (!parent || parent.lifecycle === 'closing' || parent.lifecycle === 'closed') {
    throw new Error('The parent task is closing or unavailable.');
  }
  if (parent.paused || (epoch !== undefined && epoch !== (parent.launchEpoch ?? 0))) {
    throw new Error(
      'Child launches are paused or this launch was canceled. Resume explicitly to launch again.',
    );
  }
  return parent;
}

export function stopChildren(c: CoordinatorInternals, parentId: string): void {
  const parent = c.coordinators.get(parentId);
  if (!parent) throw new Error('Parent task not registered.');
  parent.paused = true;
  parent.launchEpoch = (parent.launchEpoch ?? 0) + 1;
  for (const task of c.tasks.values()) {
    if (task.coordinatorTaskId !== parentId) continue;
    c.prompts.clearPromptDeliveryState(task.id);
    task.pendingPrompts = undefined;
    task.promptQueuedAt = undefined;
    c.controlMap.set(task.id, 'human');
    for (const agentId of agentIdsForTask(task)) killAgent(agentId);
  }
}

export function resumeChildren(c: CoordinatorInternals, parentId: string): void {
  const parent = c.coordinators.get(parentId);
  if (!parent || parent.lifecycle === 'closing' || parent.lifecycle === 'closed') {
    throw new Error('Parent task unavailable.');
  }
  parent.paused = false;
}

/** Reserve before a restored/stopped child is spawned; release in the caller's finally. */
export function reserveChildRestart(
  c: CoordinatorInternals,
  taskId: string,
): (() => void) & { assertAllowed: () => void } {
  const task = c.tasks.get(taskId);
  if (!task) return Object.assign(() => {}, { assertAllowed: () => {} });
  const parent = assertParentAdmission(c, task.coordinatorTaskId);
  const epoch = parent.launchEpoch ?? 0;
  const assertAllowed = () => {
    assertParentAdmission(c, task.coordinatorTaskId, epoch);
    if (
      c.tasks.get(taskId) !== task ||
      c.integratingTaskIds.has(taskId) ||
      c.closingTaskIds.has(taskId)
    ) {
      throw new Error('Child restart was canceled or integration is in progress.');
    }
  };
  if (c.integratingTaskIds.has(taskId)) throw new Error('Task integration is in progress.');
  // Replacing an existing PTY does not consume an additional task slot.
  if (isChildInFlight(task)) return Object.assign(() => {}, { assertAllowed });
  const parentId = task.coordinatorTaskId;
  const pending = c.pendingCreateCounts.get(parentId) ?? 0;
  const limit = clampCoordinatorConcurrentTasks(
    parent.maxConcurrentSubTasks ?? DEFAULT_COORDINATOR_CONCURRENT_TASKS,
  );
  if (countInFlightSubTasks(c, parentId) + pending >= limit)
    throw new Error('Child concurrency limit reached.');
  c.pendingCreateCounts.set(parentId, pending + 1);
  let released = false;
  return Object.assign(
    () => {
      if (released) return;
      released = true;
      const remaining = (c.pendingCreateCounts.get(parentId) ?? 1) - 1;
      if (remaining > 0) c.pendingCreateCounts.set(parentId, remaining);
      else c.pendingCreateCounts.delete(parentId);
    },
    { assertAllowed },
  );
}

function isChildInFlight(task: CoordinatedTask): boolean {
  return (
    (task.status !== 'exited' && task.status !== 'error') ||
    getActiveAgentIds().some((agentId) => getAgentMeta(agentId)?.taskId === task.id)
  );
}

export function countInFlightSubTasks(c: CoordinatorInternals, coordinatorId: string): number {
  let count = 0;
  for (const task of c.tasks.values()) {
    if (task.coordinatorTaskId !== coordinatorId) continue;
    if (!isChildInFlight(task)) continue;
    count++;
  }
  return count;
}
