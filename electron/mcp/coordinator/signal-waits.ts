// Completion signals between children and their coordinator: signal_done records
// a child's result, wait_for_signal_done hands the next one to the waiting
// coordinator. Owns the waiter queue, request-id replay, and the open-wait count
// that keeps staged notifications back while a coordinator is waiting.

import { randomUUID } from 'crypto';
import { warn as logWarn } from '../../log.js';
import { IPC } from '../../ipc/channels.js';
import { getAgentActivityEvidence } from '../../agent-hooks/observations.js';
import {
  parseSignalDoneInput,
  type CompletionRecord,
  type SignalDoneResult,
} from '../../shared/completion-report.js';
import { ReplayCache } from '../replay-cache.js';
import { execAsync } from './child-git.js';
import type { CoordinatorNotifications } from './notifications.js';
import type {
  CoordinatedTask,
  CoordinatorState,
  StalledChild,
  WaitForSignalDoneResult,
} from '../types.js';

export const DEFAULT_WAIT_TIMEOUT_MS = 300_000; // 5 minutes
// setTimeout fires after ~1ms for values above 2^31-1 and immediately for <= 0, so
// out-of-range caller input must be clamped. The floor stays small because callers
// legitimately poll with short waits; the cap is far below the setTimeout limit.
const MIN_WAIT_TIMEOUT_MS = 10;
const MAX_WAIT_TIMEOUT_MS = 60 * 60_000; // 1 hour

export function clampWaitTimeoutMs(timeoutMs: number): number {
  if (Number.isNaN(timeoutMs)) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(MIN_WAIT_TIMEOUT_MS, timeoutMs));
}

/** What completion signalling reads from, and reports to, the coordinator that owns it. */
export interface SignalWaitHost {
  readonly tasks: ReadonlyMap<string, CoordinatedTask>;
  readonly coordinators: ReadonlyMap<string, CoordinatorState>;
  readonly notifications: CoordinatorNotifications;
  /** Whether the task is being closed or integrated, which supersedes a completion. */
  isClosingOrIntegrating(taskId: string): boolean;
  withdrawCloseSuggestion(task: CoordinatedTask): void;
  stalledChildren(coordinatorTaskId: string): StalledChild[];
  notifyRenderer(channel: string, data: unknown): void;
}

export class SignalWaits {
  private anySignalResolvers = new Map<string, Array<(result: WaitForSignalDoneResult) => void>>();
  // Cancels a pending wait_for_signal_done without caching a result, keyed by
  // coordinator + requestId, so a retry can supersede its orphaned original.
  private pendingSignalWaitsByRequest = new Map<string, () => void>();
  private activeSignalWaitCounts = new Map<string, number>();
  private recentlyDelivered = new ReplayCache<WaitForSignalDoneResult>();

  constructor(private readonly host: SignalWaitHost) {}

  activeSignalWaitCount(coordinatorTaskId: string): number {
    return this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0;
  }

  /** Hand an exited task to the first wait_for_signal_done waiter so it doesn't hang
   *  when the last sub-task exits without calling signal_done. */
  deliverExitToSignalWaiter(task: CoordinatedTask): void {
    const coordinatorId = task.coordinatorTaskId;
    const firstAnyResolver = this.anySignalResolvers.get(coordinatorId)?.shift();
    if (!firstAnyResolver) return;
    // Suppress the exit notification — the signal waiter receives the
    // exit info as its return value (mirrors the signalDone path).
    if (this.host.coordinators.get(coordinatorId)?.automaticNotifications !== false) {
      this.host.notifications.suppressPendingNotificationForTask(task);
      task.reviewNotificationQueued = true;
    }
    // The resolver IS `complete` from waitForSignalDone — it handles
    // finishSignalWait, replay-cache write, and timer cleanup itself.
    firstAnyResolver({
      taskId: task.id,
      name: task.name,
      status: 'exited',
      signalDoneAt: new Date().toISOString(),
      remaining: this.countRemaining(coordinatorId),
    });
  }

  /** A removed child never signals; without this the last wait_for_signal_done
   *  would sit until its timeout once nothing is left to wait for. */
  resolveSignalWaitersIfNoneRemain(coordinatorId: string): void {
    if (this.countRemaining(coordinatorId) > 0) return;
    const waiters = this.anySignalResolvers.get(coordinatorId);
    if (!waiters?.length) return;
    // Snapshot: each resolver splices itself out of the array.
    for (const resolve of [...waiters]) resolve({ remaining: 0 });
  }

  /** Resolve any pending wait_for_signal_done calls of a closing coordinator so they
   *  don't hang until the 5-minute timeout fires. */
  resolveForDeregister(coordinatorTaskId: string): void {
    const anyResolvers = this.anySignalResolvers.get(coordinatorTaskId);
    if (anyResolvers?.length) {
      const syntheticResult: WaitForSignalDoneResult = {
        taskId: coordinatorTaskId,
        name: '',
        status: 'exited',
        signalDoneAt: new Date().toISOString(),
        remaining: 0,
      };
      // Snapshot first — each resolver is `complete` from waitForSignalDone,
      // which splices itself out of the array, and mutating during iteration
      // would skip waiters.
      const snapshot = [...anyResolvers];
      for (const resolve of snapshot) resolve(syntheticResult);
    }
    this.anySignalResolvers.delete(coordinatorTaskId);
    this.activeSignalWaitCounts.delete(coordinatorTaskId);
  }

  async signalDone(
    taskId: string,
    input: unknown = {},
    assertCallerCurrent?: () => void,
  ): Promise<SignalDoneResult> {
    const { result } = parseSignalDoneInput(input);
    const task = this.host.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const revision = task.reviewRevision ?? 0;
    const agentId = task.agentId;
    const doneToken = task.doneToken;
    const launchId = getAgentActivityEvidence(agentId)?.launchId;
    const assertCurrent = () => {
      assertCallerCurrent?.();
      if (
        this.host.tasks.get(taskId) !== task ||
        task.agentId !== agentId ||
        task.doneToken !== doneToken ||
        (task.reviewRevision ?? 0) !== revision ||
        getAgentActivityEvidence(agentId)?.launchId !== launchId ||
        task.automationWriteInFlight ||
        this.host.isClosingOrIntegrating(taskId)
      )
        throw new Error('Completion was superseded by another assignment, session, or completion.');
    };
    assertCurrent();
    let sourceCommit: string | undefined;
    let snapshotState: CompletionRecord['snapshotState'] = 'unknown';
    if (result) {
      const options = { cwd: task.worktreePath, timeout: 10_000, maxBuffer: 1024 * 1024 };
      const readHead = async () => {
        const { stdout } = await execAsync('git', ['rev-parse', '--verify', 'HEAD'], options);
        const sha = stdout.trim();
        if (!/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(sha))
          throw new Error('Cannot associate the completion report with a source commit.');
        return sha;
      };
      sourceCommit = await readHead();
      const { stdout } = await execAsync(
        'git',
        ['--no-optional-locks', 'status', '--porcelain', '-z'],
        options,
      );
      snapshotState = stdout ? 'dirty' : 'clean';
      if ((await readHead()) !== sourceCommit)
        throw new Error(
          'Source HEAD changed while capturing the completion report; submit it again.',
        );
    }
    assertCurrent();
    const completedAt = new Date();
    const completion: CompletionRecord = {
      id: randomUUID(),
      completedAt: completedAt.toISOString(),
      reviewRevision: revision + 1,
      snapshotState,
      ...(sourceCommit !== undefined && { sourceCommit }),
      ...(result !== undefined && { result }),
    };
    // No await between the final identity check and publication. A concurrent
    // capture at the old revision can no longer replace this result.
    task.reviewRevision = completion.reviewRevision;
    task.completion = completion;
    task.assignedPromptDelivered = true;
    task.suppressIdleUntil = undefined;
    task.signalDoneAt = completedAt;
    task.signalDoneConsumed = false;
    // The suggestion predates this result; the user should review it, not just close it.
    this.host.withdrawCloseSuggestion(task);

    const coordinatorId = task.coordinatorTaskId;
    const anyResolvers = this.anySignalResolvers.get(coordinatorId);
    const firstAnyResolver = anyResolvers?.length ? anyResolvers.shift() : undefined;
    if (firstAnyResolver) {
      task.signalDoneConsumed = true;
      // Ordinary parents keep a visible review queue even while their agent waits.
      if (this.host.coordinators.get(coordinatorId)?.automaticNotifications === false) {
        this.host.notifications.maybeQueueReviewNotification(
          task,
          'idle',
          task.exitCode ?? null,
          5_000,
        );
      } else this.host.notifications.suppressPendingNotificationForTask(task);
      const remaining = this.countRemaining(coordinatorId);
      // Resolver `complete` from waitForSignalDone handles finishSignalWait.
      firstAnyResolver({
        taskId,
        name: task.name,
        status: task.status,
        signalDoneAt: (task.signalDoneAt ?? new Date()).toISOString(),
        completion,
        remaining,
      });
      // Tell renderer — coordinator already gets result via MCP return value, no UI notification needed
      this.host.notifyRenderer(IPC.MCP_TaskStateSync, {
        taskId,
        signalDoneReceived: true,
        signalDoneAt: (task.signalDoneAt ?? new Date()).toISOString(),
        signalDoneConsumed: true,
        completion,
        reviewRevision: task.reviewRevision,
      });
      logWarn('coordinator.signal_wait', 'wait_for_signal_done finish', {
        taskId,
        coordinatorTaskId: coordinatorId,
        reason: 'signal',
        activeWaitCount: this.activeSignalWaitCounts.get(coordinatorId) ?? 0,
      });
      return { ok: true, completion };
    }

    // No active waiter — notify via UI so coordinator sees the completion
    this.host.notifyRenderer(IPC.MCP_TaskStateSync, {
      taskId,
      signalDoneReceived: true,
      signalDoneAt: (task.signalDoneAt ?? new Date()).toISOString(),
      signalDoneConsumed: false,
      completion,
      reviewRevision: task.reviewRevision,
    });
    // Don't queue a review notification if the agent hasn't finished spawning yet —
    // renderer state is inconsistent while status is 'creating'.
    // For 'running' and 'idle', the worker explicitly signalled done so treat as idle.
    if (task.status !== 'creating') {
      const state: 'idle' | 'exited' = task.status === 'exited' ? 'exited' : 'idle';
      this.host.notifications.maybeQueueReviewNotification(
        task,
        state,
        task.exitCode ?? null,
        5_000,
      );
    }
    return { ok: true, completion };
  }

  /** `signal` aborts when the caller is gone (HTTP request closed, tool call cancelled): its
   *  waiter must not take the next completion, or the coordinator never sees it. */
  waitForSignalDone(
    coordinatorTaskId: string,
    rawTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    { requestId, signal }: { requestId?: string; signal?: AbortSignal } = {},
  ): Promise<WaitForSignalDoneResult> {
    const timeoutMs = clampWaitTimeoutMs(rawTimeoutMs);
    if (!this.host.coordinators.has(coordinatorTaskId)) {
      return Promise.reject(new Error(`Coordinator not found: ${coordinatorTaskId}`));
    }
    if (signal?.aborted)
      return Promise.resolve({ remaining: this.countRemaining(coordinatorTaskId) });
    // Replay the cached result if this requestId already delivered — handles retry
    // after the HTTP response was lost before the client received it.
    // Key includes coordinatorTaskId to prevent cross-coordinator replay.
    if (requestId) {
      const cached = this.recentlyDelivered.get(coordinatorTaskId, requestId);
      if (cached) return Promise.resolve(cached);
    }
    // A retry with the same requestId means the original HTTP request is dead; its
    // server-side waiter would otherwise swallow the next signal.
    const requestKey = requestId ? `${coordinatorTaskId}\0${requestId}` : undefined;
    const orphan = requestKey ? this.pendingSignalWaitsByRequest.get(requestKey) : undefined;
    const immediate = this.takeImmediateSignalResult(coordinatorTaskId, requestId);
    if (immediate) {
      orphan?.();
      return Promise.resolve(immediate);
    }

    // Take the new slot before releasing the orphan's so the count never touches 0.
    this.beginSignalWait(coordinatorTaskId);
    orphan?.();
    logWarn('coordinator.signal_wait', 'wait_for_signal_done start', {
      coordinatorTaskId,
      activeWaitCount: this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0,
      timeoutMs,
    });

    return new Promise((resolve) => {
      const timerRef = { value: undefined as ReturnType<typeof setTimeout> | undefined };
      let settled = false;

      // Single termination path: timer cleanup, resolver removal, active-wait
      // bookkeeping, replay-cache write, and promise resolution all happen here
      // regardless of whether the result came from a signal, an exit, a
      // coordinator close, or the timeout. Idempotent — repeated calls are a
      // no-op so external callers can shift the resolver out before invoking.
      const settle = (result: WaitForSignalDoneResult, superseded: boolean) => {
        if (settled) return;
        settled = true;
        if (timerRef.value !== undefined) clearTimeout(timerRef.value);
        signal?.removeEventListener('abort', supersede);
        if (requestKey && this.pendingSignalWaitsByRequest.get(requestKey) === supersede) {
          this.pendingSignalWaitsByRequest.delete(requestKey);
        }
        const resolvers = this.anySignalResolvers.get(coordinatorTaskId);
        if (resolvers) {
          const idx = resolvers.indexOf(complete);
          if (idx >= 0) resolvers.splice(idx, 1);
        }
        this.finishSignalWait(coordinatorTaskId);
        // A superseded waiter must not poison the replay cache the retry relies on.
        if (requestId && !superseded) {
          this.recentlyDelivered.set(coordinatorTaskId, requestId, result);
        }
        resolve(result);
      };
      const complete = (result: WaitForSignalDoneResult) => settle(result, false);
      const supersede = () => settle({ remaining: this.countRemaining(coordinatorTaskId) }, true);
      if (requestKey) this.pendingSignalWaitsByRequest.set(requestKey, supersede);
      signal?.addEventListener('abort', supersede, { once: true });

      timerRef.value = setTimeout(() => {
        logWarn('coordinator.signal_wait', `wait_for_signal_done timed out after ${timeoutMs}ms`, {
          coordinatorTaskId,
          reason: 'timeout',
          timeoutMs,
          activeWaitCount: this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0,
        });
        const remaining = this.countRemaining(coordinatorTaskId);
        const stalled = this.host.stalledChildren(coordinatorTaskId);
        complete({ remaining, timedOut: true, ...(stalled.length ? { stalled } : {}) });
      }, timeoutMs);

      let resolvers = this.anySignalResolvers.get(coordinatorTaskId);
      if (!resolvers) {
        resolvers = [];
        this.anySignalResolvers.set(coordinatorTaskId, resolvers);
      }
      resolvers.push(complete);
    });
  }

  /** Result for a wait that can be answered without waiting: an unconsumed signal,
   *  or nothing left to wait for when automatic notifications are off. */
  private takeImmediateSignalResult(
    coordinatorTaskId: string,
    requestId: string | undefined,
  ): WaitForSignalDoneResult | undefined {
    for (const task of this.host.tasks.values()) {
      if (
        task.coordinatorTaskId === coordinatorTaskId &&
        task.signalDoneAt &&
        !task.signalDoneConsumed
      ) {
        task.signalDoneConsumed = true;
        // Suppress the staged UI notification that was queued when signalDone ran
        // without an active waiter — otherwise it will auto-fire as a duplicate.
        if (this.host.coordinators.get(coordinatorTaskId)?.automaticNotifications !== false) {
          this.host.notifications.suppressPendingNotificationForTask(task);
        }
        this.host.notifyRenderer(IPC.MCP_TaskStateSync, {
          taskId: task.id,
          signalDoneConsumed: true,
        });
        const remaining = this.countRemaining(coordinatorTaskId);
        const result = {
          taskId: task.id,
          name: task.name,
          status: task.status,
          signalDoneAt: task.signalDoneAt.toISOString(),
          completion: task.completion,
          remaining,
        };
        if (requestId) this.recentlyDelivered.set(coordinatorTaskId, requestId, result);
        return result;
      }
    }

    if (
      this.host.coordinators.get(coordinatorTaskId)?.automaticNotifications === false &&
      this.countRemaining(coordinatorTaskId) === 0
    )
      return { remaining: 0 };
    return undefined;
  }

  private countRemaining(coordinatorTaskId: string): number {
    let count = 0;
    for (const task of this.host.tasks.values()) {
      if (task.coordinatorTaskId !== coordinatorTaskId) continue;
      if (task.signalDoneConsumed) continue; // coordinator already processed this one
      if (task.status === 'exited' && !task.signalDoneAt) continue; // exited without signal — handled by UI
      if (task.closeSuggestion) continue; // the coordinator gave it up; the user closes it
      count++;
    }
    return count;
  }

  private beginSignalWait(coordinatorTaskId: string): void {
    this.activeSignalWaitCounts.set(
      coordinatorTaskId,
      (this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0) + 1,
    );
    const coordinator = this.host.coordinators.get(coordinatorTaskId);
    if (coordinator && coordinator.automaticNotifications !== false) {
      this.host.notifications.clearStagedNotificationForCoordinator(coordinator);
    }
  }

  private finishSignalWait(coordinatorTaskId: string): void {
    const current = this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0;
    if (current <= 1) {
      this.activeSignalWaitCounts.delete(coordinatorTaskId);
    } else {
      this.activeSignalWaitCounts.set(coordinatorTaskId, current - 1);
      return;
    }

    const coordinator = this.host.coordinators.get(coordinatorTaskId);
    if (coordinator && coordinator.pendingNotifications.length > 0) {
      this.host.notifications.stageBatch(coordinator);
    }
  }
}
