// Taking tasks and coordinators out of the coordinator: closing, cleanup after
// landing, detaching children and deregistering a coordinator.

import { restoreCoordinatorMcpJson, unlinkMcpConfigFile } from './mcp-config.js';
import type { CoordinatorInternals } from './internals.js';
import { type MergedLines } from './landing.js';
import { deleteTask } from '../../ipc/tasks.js';
import { projectTeardownOptions } from '../../ipc/project-teardown.js';
import { killAgent } from '../../ipc/pty.js';
import { verificationRunner } from '../../ipc/verify.js';
import type { CoordinatedTask } from '../types.js';
import { IPC } from '../../ipc/channels.js';
import {
  assertOrchestrationEnabled,
  agentIdsForTask,
  resolveIdleWaiters,
  notifyRenderer,
} from './internals.js';
import {
  unsubscribeAgentOutput,
  clearAgentBuffers,
  clearAgentOutputState,
} from './agent-events.js';

/** Detach first; the caller persists these IDs before removing the parent's worktree. */
export function detachChildren(c: CoordinatorInternals, parentId: string): string[] {
  const children = [...c.tasks.values()].filter((task) => task.coordinatorTaskId === parentId);
  if (
    (c.pendingCreateCounts.get(parentId) ?? 0) > 0 ||
    children.some((task) => task.status === 'creating')
  ) {
    throw new Error(
      'A child launch is still settling. Retry closing after it finishes or is canceled.',
    );
  }
  if (children.some((task) => c.integratingTaskIds.has(task.id))) {
    throw new Error('A child is being integrated. Wait for integration before closing the parent.');
  }
  const parent = c.coordinators.get(parentId);
  if (parent) {
    parent.lifecycle = 'closing';
    parent.paused = true;
    parent.launchEpoch = (parent.launchEpoch ?? 0) + 1;
  }
  deregisterCoordinator(c, parentId);
  for (const task of children) removeCoordinatedTask(c, task.id);
  return children.map((task) => task.id);
}

/** Detach one child while its parent keeps running. Returns the former parent's id, if any. */
export function detachChild(c: CoordinatorInternals, childId: string): string | undefined {
  const task = c.tasks.get(childId);
  if (!task) return undefined;
  if (task.status === 'creating')
    throw new Error('The child is still starting. Retry detaching after it finishes.');
  if (c.integratingTaskIds.has(childId))
    throw new Error('The child is being integrated. Wait for integration before detaching.');
  removeCoordinatedTask(c, childId);
  return task.coordinatorTaskId;
}

function clearTaskMcpConfig(task: CoordinatedTask): void {
  unlinkMcpConfigFile(task.mcpConfigPath);
  task.mcpConfigPath = undefined;
}

function clearTaskControlState(c: CoordinatorInternals, taskId: string): void {
  c.prompts.clearPromptDeliveryState(taskId);
  c.controlMap.delete(taskId);
}

/** Kills the task's agents, runs the project's teardown script, then deletes
 *  the worktree and branch. Resolves to the teardown's failure notice, if any. */
async function killAgentsAndDeleteWorktree(task: CoordinatedTask): Promise<string | undefined> {
  // Kill the agent. For Docker sub-tasks, killAgent also calls docker stop on the
  // sub-task's own container (via stopDockerContainer in pty.ts), which cleanly
  // terminates the entire container rather than just the PTY client process.
  const agentIds = agentIdsForTask(task);
  for (const agentId of agentIds) {
    try {
      killAgent(agentId);
    } catch {
      /* already dead */
    }
  }
  const result = await deleteTask({
    agentIds,
    branchName: task.branchName,
    deleteBranch: true,
    projectRoot: task.projectRoot,
    worktreePath: task.worktreePath,
    ...projectTeardownOptions(task.projectId),
  });
  return result?.teardownWarning;
}

export async function cleanupLandedTaskResources(
  c: CoordinatorInternals,
  task: CoordinatedTask,
  merged: MergedLines,
): Promise<void> {
  c.closingTaskIds.add(task.id);
  try {
    c.notifications.suppressPendingNotificationForTask(task);
    c.notifications.queueLandedNotification(task);

    clearAgentOutputState(c, task);

    const teardownWarning = await killAgentsAndDeleteWorktree(task);

    resolveIdleWaiters(c, task.id, 'exited');
    clearTaskMcpConfig(task);
    task.status = 'exited';
    task.exitCode = 0;
    c.tasks.delete(task.id);
    clearTaskControlState(c, task.id);
    notifyRenderer(c, IPC.MCP_TaskClosed, {
      taskId: task.id,
      merged,
      ...(teardownWarning && { teardownWarning }),
    });
  } finally {
    c.closingTaskIds.delete(task.id);
  }
}

export async function closeTask(c: CoordinatorInternals, taskId: string): Promise<void> {
  assertOrchestrationEnabled(c);
  if (c.integratingTaskIds.has(taskId)) throw new Error('Task integration is in progress.');
  const task = c.tasks.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  await cleanupTask(c, taskId);
}

/**
 * Remove a coordinated task's backend state when the UI closes it directly.
 * Unlike cleanupTask, this does NOT kill the agent or delete the worktree —
 * the UI has already done both. It only cleans up in-memory coordinator state.
 */
export function removeCoordinatedTask(c: CoordinatorInternals, taskId: string): void {
  const task = c.tasks.get(taskId);
  if (!task) return;

  c.notifications.suppressPendingNotificationForTask(task, true);

  clearAgentOutputState(c, task);
  resolveIdleWaiters(c, taskId, 'removed');
  clearTaskMcpConfig(task);

  // For Docker sub-tasks, the UI calls killAgent before removeCoordinatedTask,
  // which stops the sub-task's own container via stopDockerContainer in pty.ts.
  // No additional docker cleanup needed here.

  c.tasks.delete(taskId);
  clearTaskControlState(c, taskId);
  c.signalWaits.resolveSignalWaitersIfNoneRemain(task.coordinatorTaskId);
}

/** `merged` says the task leaves because it was merged (for the renderer's
 *  Super Productivity note); a plain close or failed start passes nothing. */
export function cleanupTask(
  c: CoordinatorInternals,
  taskId: string,
  merged?: MergedLines,
): Promise<void> {
  // Concurrent closes share one run so deleteTask is not issued twice.
  const inFlight = c.cleanupsInFlight.get(taskId);
  if (inFlight) return inFlight;
  const run = cleanupTaskOnce(c, taskId, merged).finally(() => {
    c.cleanupsInFlight.delete(taskId);
  });
  c.cleanupsInFlight.set(taskId, run);
  return run;
}

async function cleanupTaskOnce(
  c: CoordinatorInternals,
  taskId: string,
  merged?: MergedLines,
): Promise<void> {
  const task = c.tasks.get(taskId);
  if (!task) return;
  // An exit before this close was already reported; only one landing during it is new.
  const exitedBeforeClose = task.status === 'exited';
  c.closingTaskIds.add(taskId);
  c.notifications.suppressPendingNotificationForTask(task, true);

  unsubscribeAgentOutput(c, task.agentId);
  // A verify run still going would keep writing into the worktree we delete.
  verificationRunner.cancel(taskId);

  // Remove worktree. If this fails, keep all coordinator state so the caller
  // can retry. Do NOT emit MCP_TaskClosed — the task still exists on disk.
  let teardownWarning: string | undefined;
  try {
    teardownWarning = await killAgentsAndDeleteWorktree(task);
  } catch (err) {
    console.warn('Failed to delete coordinated task worktree:', err);
    c.prompts.clearPromptDeliveryState(taskId);
    c.closingTaskIds.delete(taskId);
    // The exit handler skips signal waiters while a task is closing, so an
    // exit that landed during this attempt would otherwise leave them hanging.
    if (!exitedBeforeClose && task.status === 'exited')
      c.signalWaits.deliverExitToSignalWaiter(task);
    notifyRenderer(c, IPC.MCP_TaskCleanupFailed, {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    // The agent that asked for the close must not be told the task is gone.
    throw err;
  }

  // Clean up internal state — resolve idle and signal waiters before deleting
  // so callers don't hang until their own timeout fires.
  resolveIdleWaiters(c, taskId, 'exited');
  // Guard against double-resolve: the PTY exit handler (onPtyEvent 'exit') may have
  // already consumed a resolver if the process exited between killAgent and here.
  // reviewNotificationQueued is set by whichever path runs first.
  if (!task.reviewNotificationQueued) c.signalWaits.deliverExitToSignalWaiter(task);
  clearAgentBuffers(c, task.agentId);
  clearTaskMcpConfig(task);
  c.tasks.delete(taskId);
  clearTaskControlState(c, taskId);
  c.closingTaskIds.delete(taskId);

  // Notify renderer
  notifyRenderer(c, IPC.MCP_TaskClosed, {
    taskId,
    ...(merged && { merged }),
    ...(teardownWarning && { teardownWarning }),
  });
}

export function deregisterCoordinator(c: CoordinatorInternals, coordinatorTaskId: string): void {
  if (
    [...c.tasks.values()].some(
      (task) => task.coordinatorTaskId === coordinatorTaskId && c.integratingTaskIds.has(task.id),
    )
  )
    throw new Error('Child integration is in progress.');
  const coordinator = c.coordinators.get(coordinatorTaskId);
  if (!coordinator) return;
  coordinator.lifecycle = 'closing';
  c.notifications.clearForDeregister(coordinator);

  restoreCoordinatorMcpJson(coordinator);

  c.coordinators.delete(coordinatorTaskId);
  c.landing.forgetCoordinator(coordinatorTaskId);

  // Resolve any pending wait_for_signal_done calls so they don't hang until
  // the 5-minute timeout fires after the coordinator closes.
  c.signalWaits.resolveForDeregister(coordinatorTaskId);

  // Mark all child tasks belonging to this coordinator as orphaned so that
  // signal_done calls from still-running sub-tasks can still resolve.
  // Do NOT delete the task records — they must remain so signal_done can find them.
  for (const [taskId, task] of c.tasks) {
    if (task.coordinatorTaskId !== coordinatorTaskId) continue;

    clearAgentOutputState(c, task);
    c.prompts.clearPromptDeliveryState(taskId);

    // Resolve pending idle waiters so callers aren't left hanging
    resolveIdleWaiters(c, taskId, 'exited');

    // If the prompt hadn't been delivered yet, silence future orphaned notifications:
    // the task never started real work so there's nothing to review. If the prompt
    // WAS already delivered, leave reviewNotificationQueued unset so the next idle
    // or exit fires the expected orphaned notification for the user to act on.
    if (!task.assignedPromptDelivered) {
      task.reviewNotificationQueued = true;
    } else {
      task.suppressIdleUntil = undefined;
    }

    // Transfer control to human so the user can decide what to do with orphaned tasks
    c.controlMap.set(taskId, 'human');

    clearTaskMcpConfig(task);

    // Notify the frontend so it can detach children consistently regardless
    // of whether backend deregistration or renderer close cleanup wins the IPC race.
    notifyRenderer(c, IPC.MCP_TaskStateSync, {
      taskId,
      coordinatedBy: null,
      controlledBy: null,
      mcpConfigPath: null,
      mcpStartupStatus: null,
      mcpStartupError: null,
      needsReview: task.assignedPromptDelivered,
    });
  }
}
