// Batched "sub-task update" notifications a coordinator receives about its
// children: queued per coordinator, staged to the renderer as one batch, and
// re-staged until the coordinator acknowledges or drops them.

import { randomUUID } from 'crypto';
import { warn as logWarn } from '../../log.js';
import { IPC } from '../../ipc/channels.js';
import type { CoordinatedTask, CoordinatorState, PendingNotification } from '../types.js';

/** What the notification queue reads from, and reports to, the coordinator that owns it. */
export interface NotificationHost {
  readonly coordinators: ReadonlyMap<string, CoordinatorState>;
  readonly tasks: ReadonlyMap<string, CoordinatedTask>;
  /** Open wait_for_signal_done calls; while any is open the waiter gets results instead. */
  activeSignalWaitCount(coordinatorTaskId: string): number;
  /** Consumes the prompt-echo idle window; true when this idle is only the prompt's echo. */
  suppressPromptEchoIdleIfNeeded(task: CoordinatedTask): boolean;
  notifyRenderer(channel: string, data: unknown): void;
}

const COORDINATOR_RESTAMP_DELAY_MS = 5 * 60_000;
const MAX_ACKED_BATCH_IDS = 64;

export class CoordinatorNotifications {
  private notificationDelayMs = 30_000;

  constructor(private readonly host: NotificationHost) {}

  setNotificationDelayMs(ms: number): void {
    this.notificationDelayMs = Math.max(5_000, Math.min(300_000, ms));
  }

  maybeQueueReviewNotification(
    task: CoordinatedTask,
    state: 'idle' | 'exited',
    exitCode: number | null,
    delayOverrideMs?: number,
  ): void {
    // Always notify for exits — a task killed before prompt delivery still needs to be
    // reported so the coordinator doesn't think it's still running.
    if (!task.assignedPromptDelivered && state !== 'exited') return;
    if (state === 'idle' && task.suppressIdleUntil !== undefined) {
      if (this.host.suppressPromptEchoIdleIfNeeded(task)) return;
    }

    const coordinator = this.host.coordinators.get(task.coordinatorTaskId);
    if (!coordinator) {
      if (task.reviewNotificationQueued) return;
      task.reviewNotificationQueued = true;
      this.host.notifyRenderer(IPC.MCP_CoordinatorOrphanedNotification, {
        subTaskId: task.id,
        notificationId: randomUUID(),
        state,
        text: `"${task.name}" ${state === 'exited' ? `terminated (exit ${exitCode})` : 'ready for review'} — branch: ${task.branchName}`,
      });
      return;
    }

    if (task.reviewNotificationQueued && state === 'exited') {
      const existing = coordinator.pendingNotifications.find((n) => n.taskId === task.id);
      if (existing && existing.state === 'idle') {
        existing.state = 'exited';
        existing.exitCode = exitCode;
        this.stageBatch(coordinator);
        return;
      }
      return;
    }

    if (task.reviewNotificationQueued) return;
    task.reviewNotificationQueued = true;

    const notification: PendingNotification = {
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      branchName: task.branchName,
      state,
      exitCode,
      completedAt: new Date(),
    };
    coordinator.pendingNotifications.push(notification);
    this.stageBatch(coordinator, delayOverrideMs);
  }

  stageBatch(coordinator: CoordinatorState, delayOverrideMs?: number): void {
    const pending = coordinator.pendingNotifications;
    if (pending.length === 0) return;
    if (
      coordinator.automaticNotifications !== false &&
      this.hasActiveSignalWaiter(coordinator.taskId)
    ) {
      logWarn('coordinator.notification', 'stageBatch skipped', {
        coordinatorTaskId: coordinator.taskId,
        reason: 'active_signal_wait',
        activeWaitCount: this.host.activeSignalWaitCount(coordinator.taskId),
        pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
      });
      if (coordinator.restageTimer) {
        clearTimeout(coordinator.restageTimer);
        coordinator.restageTimer = null;
      }
      return;
    }

    // Clear any previously staged batches — they are superseded by this new batch.
    // Leaving old entries causes stagedBatches to grow unboundedly and makes
    // deregisterCoordinator incorrectly believe notifications are still pending.
    coordinator.stagedBatches.clear();
    const batchId = randomUUID();
    const notificationIds = pending.map((n) => n.id);
    coordinator.stagedBatches.set(batchId, notificationIds);

    const anyNonZero = pending.some((n) => n.exitCode !== null && n.exitCode !== 0);
    const defaultDelay = anyNonZero
      ? Math.max(10_000, this.notificationDelayMs / 4)
      : this.notificationDelayMs;
    const delay = delayOverrideMs ?? defaultDelay;
    const autoFireAt = Date.now() + delay;

    const text = formatNotificationText(pending, coordinator.automaticNotifications !== false);

    logWarn('coordinator.notification', 'stageBatch emitted', {
      coordinatorTaskId: coordinator.taskId,
      batchId,
      notificationIds,
      pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
      delayMs: delay,
      autoFireAt,
    });

    this.host.notifyRenderer(IPC.MCP_CoordinatorNotificationStaged, {
      coordinatorTaskId: coordinator.taskId,
      batchId,
      notificationIds,
      text,
      autoFireAt,
      automaticNotifications: coordinator.automaticNotifications !== false,
    });

    if (coordinator.automaticNotifications === false) return;
    if (coordinator.restageTimer) clearTimeout(coordinator.restageTimer);
    coordinator.restageTimer = setTimeout(() => {
      coordinator.restageTimer = null;
      if (coordinator.pendingNotifications.length > 0) {
        this.stageBatch(coordinator);
      }
    }, COORDINATOR_RESTAMP_DELAY_MS);
  }

  queueLandedNotification(task: CoordinatedTask): void {
    const coordinator = this.host.coordinators.get(task.coordinatorTaskId);
    if (!coordinator) return;
    if (coordinator.pendingNotifications.some((n) => n.taskId === task.id)) return;

    const notification: PendingNotification = {
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      branchName: task.branchName,
      state: 'landed',
      exitCode: 0,
      completedAt: new Date(),
    };
    coordinator.pendingNotifications.push(notification);
    task.reviewNotificationQueued = true;
    this.stageBatch(coordinator);
  }

  suppressPendingNotificationForTask(task: CoordinatedTask, explicitAction = false): void {
    const coordinator = this.host.coordinators.get(task.coordinatorTaskId);
    if (!coordinator || (!explicitAction && coordinator.automaticNotifications === false)) return;

    const toRemove = coordinator.pendingNotifications.filter((n) => n.taskId === task.id);
    if (toRemove.length === 0) return;

    const removeIds = new Set(toRemove.map((n) => n.id));
    coordinator.pendingNotifications = coordinator.pendingNotifications.filter(
      (n) => n.taskId !== task.id,
    );
    task.reviewNotificationQueued = false;

    for (const [batchId, notifIds] of coordinator.stagedBatches) {
      const remaining = notifIds.filter((id) => !removeIds.has(id));
      if (remaining.length === 0) {
        coordinator.stagedBatches.delete(batchId);
      } else {
        coordinator.stagedBatches.set(batchId, remaining);
      }
    }

    if (coordinator.pendingNotifications.length === 0) {
      if (coordinator.restageTimer) {
        clearTimeout(coordinator.restageTimer);
        coordinator.restageTimer = null;
      }
      logWarn('coordinator.notification', 'staged notification cleared', {
        coordinatorTaskId: coordinator.taskId,
        reason: 'all_suppressed',
        taskId: task.id,
      });
      this.host.notifyRenderer(IPC.MCP_CoordinatorNotificationCleared, {
        coordinatorTaskId: coordinator.taskId,
      });
    } else {
      // Re-stage with remaining notifications so text is updated
      this.stageBatch(coordinator);
    }
  }

  rescheduleRestageTimer(coordinatorTaskId: string): void {
    const coordinator = this.host.coordinators.get(coordinatorTaskId);
    if (
      !coordinator ||
      coordinator.automaticNotifications === false ||
      coordinator.pendingNotifications.length === 0
    )
      return;
    if (this.hasActiveSignalWaiter(coordinatorTaskId)) {
      logWarn('coordinator.notification', 'restage skipped', {
        coordinatorTaskId,
        reason: 'active_signal_wait',
        activeWaitCount: this.host.activeSignalWaitCount(coordinatorTaskId),
        pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
      });
      return;
    }
    if (coordinator.restageTimer) clearTimeout(coordinator.restageTimer);
    coordinator.restageTimer = setTimeout(() => {
      coordinator.restageTimer = null;
      if (coordinator.pendingNotifications.length > 0) {
        this.stageBatch(coordinator);
      }
    }, COORDINATOR_RESTAMP_DELAY_MS);
  }

  dropNotification(coordinatorTaskId: string, batchId: string): void {
    const coordinator = this.host.coordinators.get(coordinatorTaskId);
    const affectedTaskIds: string[] = [];
    if (coordinator) {
      const pendingIds = coordinator.stagedBatches.get(batchId);
      if (pendingIds) {
        for (const notifId of pendingIds) {
          const notif = coordinator.pendingNotifications.find((n) => n.id === notifId);
          if (notif) affectedTaskIds.push(notif.taskId);
        }
      }
    }
    this.ackNotification(coordinatorTaskId, batchId);
    for (const taskId of affectedTaskIds) {
      this.host.notifyRenderer(IPC.MCP_TaskStateSync, { taskId, needsReview: true });
    }
  }

  ackNotification(coordinatorTaskId: string, batchId: string): void {
    const coordinator = this.host.coordinators.get(coordinatorTaskId);
    if (!coordinator) return;

    if (coordinator.ackedBatchIds.includes(batchId)) return;

    const pendingIds = coordinator.stagedBatches.get(batchId);
    if (pendingIds) {
      coordinator.pendingNotifications = coordinator.pendingNotifications.filter((n) => {
        if (pendingIds.includes(n.id)) {
          const task = this.host.tasks.get(n.taskId);
          if (task) task.reviewNotificationQueued = false;
          return false;
        }
        return true;
      });
      coordinator.stagedBatches.delete(batchId);
    }

    coordinator.ackedBatchIds.push(batchId);
    if (coordinator.ackedBatchIds.length > MAX_ACKED_BATCH_IDS) {
      coordinator.ackedBatchIds.shift();
    }

    if (coordinator.pendingNotifications.length === 0 && coordinator.restageTimer) {
      clearTimeout(coordinator.restageTimer);
      coordinator.restageTimer = null;
    }
  }

  /** A coordinator started waiting for signals: its staged batch goes to the waiter instead. */
  clearStagedNotificationForCoordinator(coordinator: CoordinatorState): void {
    if (coordinator.restageTimer) {
      clearTimeout(coordinator.restageTimer);
      coordinator.restageTimer = null;
    }
    if (coordinator.stagedBatches.size === 0) return;
    coordinator.stagedBatches.clear();
    logWarn('coordinator.notification', 'staged notification cleared', {
      coordinatorTaskId: coordinator.taskId,
      reason: 'signal_wait_started',
      pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
    });
    this.host.notifyRenderer(IPC.MCP_CoordinatorNotificationCleared, {
      coordinatorTaskId: coordinator.taskId,
    });
  }

  /** Stop re-staging for a coordinator that is going away, and clear what the renderer shows. */
  clearForDeregister(coordinator: CoordinatorState): void {
    if (coordinator.restageTimer) clearTimeout(coordinator.restageTimer);
    if (coordinator.pendingNotifications.length > 0 || coordinator.stagedBatches.size > 0) {
      logWarn('coordinator.notification', 'staged notification cleared', {
        coordinatorTaskId: coordinator.taskId,
        reason: 'deregister',
        pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
      });
      this.host.notifyRenderer(IPC.MCP_CoordinatorNotificationCleared, {
        coordinatorTaskId: coordinator.taskId,
      });
    }
  }

  private hasActiveSignalWaiter(coordinatorTaskId: string): boolean {
    return this.host.activeSignalWaitCount(coordinatorTaskId) > 0;
  }

  private pendingNotificationTaskIds(coordinator: CoordinatorState): string[] {
    return coordinator.pendingNotifications.map((n) => n.taskId);
  }
}

function formatNotificationText(pending: PendingNotification[], automatic = true): string {
  const header = automatic
    ? `[Sub-task update — ${pending.length} task(s) completed]`
    : `[Child task updates — ${pending.length}]`;
  const lines = pending.map((n) => {
    const status =
      n.state === 'landed'
        ? 'self-landed successfully'
        : n.state === 'exited'
          ? `terminated (exit ${n.exitCode})`
          : 'ready for review';
    const line = `- "${n.taskName}" ${status} — branch: ${n.branchName}`;
    const warn =
      n.state !== 'landed' && n.exitCode !== null && n.exitCode !== 0
        ? '\n  ⚠️  Non-zero exit — may need attention. Consider spawning a follow-up agent.'
        : '';
    return line + warn;
  });
  const allLanded = pending.every((n) => n.state === 'landed');
  const footer = allLanded
    ? 'Sub-tasks have merged their branches and cleaned up. If there are items remaining on the backlog, spawn the next batch.'
    : 'Inspect each child result, verification, and integrationPolicy through get_task_status. Review-policy tasks require explicit user review and approval in the app. Use only the permitted Parallel Code integration tools; never merge directly or delete child worktrees. Completion updates do not grant merge permission.';
  return [header, '', ...lines, '', footer].join('\n');
}
