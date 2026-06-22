// Main-process coordinator for managing sub-agent tasks.
// Manages task lifecycle independently of the SolidJS renderer,
// using existing backend primitives (pty, git, tasks).

import { randomUUID, randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { unlinkSync, readFileSync, existsSync } from 'fs';
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  unlink as fsUnlink,
  access as fsAccess,
  mkdir as fsMkdir,
} from 'fs/promises';
import { join, dirname } from 'path';
import os from 'os';
import { getSubTaskMcpConfigPath } from './config.js';
import { buildMcpLaunchArgs } from './agent-args.js';
import { validateBranchName } from './validation.js';
import { atomicWriteFileSync, atomicWriteFile } from './atomic.js';
import { ReplayCache } from './replay-cache.js';
import {
  detectPreambleFiles,
  filterDiffSections,
  buildNormalizedPreambleFileDiff,
  stripPreambleFromBranch,
} from './preamble.js';

const execAsync = promisify(execFile);
import type { BrowserWindow } from 'electron';
import { createTask as createBackendTask, deleteTask } from '../ipc/tasks.js';
import { getSkipPermissionsArgs } from '../ipc/agents.js';
import {
  spawnAgent,
  writeToAgent,
  killAgent,
  subscribeToAgent,
  unsubscribeFromAgent,
  getAgentScrollback,
  onPtyEvent,
} from '../ipc/pty.js';
import {
  getChangedFiles,
  getAllFileDiffs,
  getDiffBaseSha,
  mergeTask as gitMergeTask,
} from '../ipc/git.js';
import {
  stripAnsi,
  chunkContainsAgentPrompt,
  getAgentPromptReadiness,
  AGENT_READY_TAIL_CHARS,
} from './prompt-detect.js';
import { SUB_TASK_PREAMBLE } from './sub-task-preamble.js';
import { info as logInfo, warn as logWarn } from '../log.js';
import type {
  CoordinatedTask,
  PendingNotification,
  CoordinatorState,
  ApiTaskSummary,
  ApiTaskDetail,
  ApiDiffResult,
  ApiLandSelfResult,
  LandSelfInput,
  LandingState,
  SubtaskVerification,
  WaitForSignalDoneResult,
} from './types.js';
import { IPC } from '../ipc/channels.js';

const DEFAULT_WAIT_TIMEOUT_MS = 300_000; // 5 minutes
const PROMPT_WRITE_DELAY_MS = 50;
const GIT_LOCK_RETRY_DELAY_MS = 2_000;
const INITIAL_PROMPT_READY_DELAY_MS = 1_500;
const MAX_PENDING_PROMPTS = 32;
const MAX_PROMPT_BYTES = 64 * 1024;
const PROMPT_ECHO_IDLE_SUPPRESSION_MS = 2_000;
const FOCUS_IN = '\x1b[I';
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const REST_COORDINATOR_SENTINEL = 'api';
const PREAMBLE_ARTIFACT_PATHS = new Set([
  'AGENTS.md',
  'GEMINI.md',
  '.agent.md',
  '.claude/settings.local.json',
]);
const UNRESOLVED_LANDED_COMMIT = 'unresolved';

function pasteDelayMs(text: string): number {
  const lines = text.split('\n').length;
  return Math.min(500, Math.max(50, lines * 15));
}

class PromptWriteError extends Error {
  constructor(
    message: string,
    readonly phase: 'body' | 'enter',
    cause: unknown,
  ) {
    const suffix = cause instanceof Error ? `: ${cause.message}` : '';
    super(`${message}${suffix}`);
    this.name = 'PromptWriteError';
  }
}

function isPassedVerification(verification: SubtaskVerification | undefined): boolean {
  return Boolean(
    verification?.checks.length && verification.checks.every((check) => check.result === 'passed'),
  );
}

function verificationFailureReason(verification: SubtaskVerification | undefined): string {
  if (!verification?.checks.length) return 'land_self requires at least one verification check';
  const failed = verification.checks.find((check) => check.result !== 'passed');
  if (!failed) return 'verification passed';
  return `verification ${failed.result}: ${failed.name}${failed.reason ? ` — ${failed.reason}` : ''}`;
}

function parsePorcelainPaths(statusOut: string): string[] {
  return statusOut
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const renameMarker = ' -> ';
      const rawPath = line.slice(3);
      if (!rawPath.includes(renameMarker)) return rawPath;
      const parts = rawPath.split(renameMarker);
      return parts[parts.length - 1] ?? rawPath;
    });
}

function execStdout(result: Awaited<ReturnType<typeof execAsync>>): string {
  const stdout = typeof result === 'string' ? result : result.stdout;
  return typeof stdout === 'string' ? stdout : stdout.toString('utf8');
}

/**
 * The per-sub-task MCP config: a stdio launch of the parallel-code MCP server
 * scoped to one task. Identical across createTask, coordinator re-registration,
 * and hydration rewrite — only the resolved doneToken differs, so callers own
 * token generation and pass the final value in.
 */
function buildSubtaskMcpConfig(args: {
  serverPath: string;
  serverUrl: string;
  subtaskToken: string;
  taskId: string;
  doneToken: string;
}) {
  return {
    mcpServers: {
      'parallel-code': {
        type: 'stdio' as const,
        command: 'node',
        args: [args.serverPath, '--url', args.serverUrl, '--task-id', args.taskId],
        env: {
          PARALLEL_CODE_MCP_TOKEN: args.subtaskToken,
          PARALLEL_CODE_MCP_DONE_TOKEN: args.doneToken,
        },
      },
    },
  };
}

export class Coordinator {
  private tasks = new Map<string, CoordinatedTask>();
  private tailBuffers = new Map<string, string>();
  private idleResolvers = new Map<
    string,
    Array<(result: { reason: 'idle' | 'human_control' | 'exited' | 'removed' }) => void>
  >();
  private anySignalResolvers = new Map<string, Array<(result: WaitForSignalDoneResult) => void>>();
  private subscribers = new Map<string, (encoded: string) => void>();
  private decoders = new Map<string, TextDecoder>();
  private controlMap = new Map<string, 'coordinator' | 'human'>();
  private writingPromptTaskIds = new Set<string>();
  private initialPromptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private initialPromptReadyTasks = new Set<string>();
  private promptReadySeenAt = new Map<string, number>();
  private queuedPromptFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private bracketedPasteAgentIds = new Set<string>();
  private closingTaskIds = new Set<string>();
  private activeSignalWaitCounts = new Map<string, number>();
  private recentlyDelivered = new ReplayCache<WaitForSignalDoneResult>();
  private win: BrowserWindow | null = null;
  private projectRoot: string | null = null;
  private projectId: string | null = null;
  private defaultCoordinatorTaskId: string | null = null;
  private landedOrderCounters = new Map<string, number>();
  private coordinatorSpawnDefaults: { command: string; args: string[] } = {
    command: 'claude',
    args: [],
  };
  private coordinators = new Map<string, CoordinatorState>();
  private notificationDelayMs = 30_000;
  private readonly COORDINATOR_RESTAMP_DELAY_MS = 5 * 60_000;
  private readonly MAX_ACKED_BATCH_IDS = 64;
  // Serializes concurrent preamble writes to the same file path.
  private preambleWriteQueue = new Map<string, Promise<void>>();
  constructor() {
    // Listen for PTY exits to update task status when agents are killed externally
    // (e.g., user closes a child task from the UI).
    // The singleton guard in enableCoordinatorMode (if (coordinator) return) ensures
    // this constructor is called at most once per app lifetime; no teardown needed.
    onPtyEvent('exit', (agentId, data) => {
      for (const task of this.tasks.values()) {
        if (task.agentId === agentId) {
          const { exitCode } = (data ?? {}) as { exitCode?: number };
          task.status = 'exited';
          task.exitCode = exitCode ?? null;
          // Resolve any idle waiters so they don't hang
          const resolvers = this.idleResolvers.get(task.id);
          if (resolvers?.length) {
            for (const resolve of resolvers) resolve({ reason: 'exited' });
            this.idleResolvers.delete(task.id);
          }
          if (this.closingTaskIds.has(task.id)) break;
          // Resolve any signal waiters so wait_for_signal_done doesn't hang
          // when the last sub-task exits without calling signal_done.
          const coordinatorId = task.coordinatorTaskId;
          const anyResolvers = this.anySignalResolvers.get(coordinatorId);
          const firstAnyResolver = anyResolvers?.length ? anyResolvers.shift() : undefined;
          if (firstAnyResolver) {
            // Suppress the exit notification — the signal waiter receives the
            // exit info as its return value (mirrors the signalDone path).
            this.suppressPendingNotificationForTask(task);
            task.reviewNotificationQueued = true;
            const remaining = this.countRemaining(coordinatorId);
            // The resolver IS `complete` from waitForSignalDone — it handles
            // finishSignalWait, replay-cache write, and timer cleanup itself.
            firstAnyResolver({
              taskId: task.id,
              name: task.name,
              status: 'exited',
              signalDoneAt: new Date().toISOString(),
              remaining,
            });
          }
          this.maybeQueueReviewNotification(task, 'exited', exitCode ?? null);
          break;
        }
      }
    });

    // Re-subscribe our output callback when the renderer reattaches to, or explicitly
    // replaces, a managed agent. Without this, our outputCb is lost and we can never
    // detect idle for that sub-task.
    onPtyEvent('spawn', (agentId) => {
      const outputCb = this.subscribers.get(agentId);
      if (!outputCb) return; // not a coordinated agent, or initial spawn (not yet subscribed)
      this.tailBuffers.set(agentId, ''); // replaced PTYs should not inherit old prompt text
      for (const task of this.tasks.values()) {
        if (task.agentId === agentId && task.status === 'exited') {
          task.status = 'running';
          task.exitCode = null;
        }
        if (task.agentId === agentId) {
          this.updateTailFromScrollback(task);
        }
      }
      subscribeToAgent(agentId, outputCb);
    });
  }

  setTaskControl(taskId: string, who: 'coordinator' | 'human'): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (who === 'human' && task.initialPrompt && !task.assignedPromptDelivered) {
      logInfo('coordinator.control', 'ignored human hold before initial prompt delivery', {
        taskId,
      });
      return;
    }
    this.controlMap.set(taskId, who);
    if (who === 'human') {
      // Resolve any pending idle waiters immediately — human has taken over
      const resolvers = this.idleResolvers.get(taskId);
      if (resolvers?.length) {
        for (const resolve of resolvers) resolve({ reason: 'human_control' });
        this.idleResolvers.delete(taskId);
      }
    }
    if (who === 'coordinator') {
      const hasQueuedWork = Boolean(
        task?.initialPrompt || (task?.pendingPrompts && task.pendingPrompts.length > 0),
      );
      // Fire any idle resolvers queued while human had control
      const resolvers = this.idleResolvers.get(taskId);
      if (!hasQueuedWork && resolvers?.length) {
        for (const resolve of resolvers) resolve({ reason: 'idle' });
        this.idleResolvers.delete(taskId);
      }
      if (task?.initialPrompt) {
        this.clearInitialPromptTimer(task.id);
        this.scheduleInitialPromptDelivery(task, 0);
      } else if (task?.pendingPrompts?.length) {
        void this.flushNextQueuedPrompt(task);
      }
    }
  }

  private normalizedTail(agentId: string): string {
    const tail = (this.tailBuffers.get(agentId) ?? '').slice(-AGENT_READY_TAIL_CHARS * 2);
    return (
      stripAnsi(tail)
        // eslint-disable-next-line no-control-regex -- preserve line breaks for anchored prompt detection.
        .replace(/[\x00-\x09\x0b-\x0c\x0e-\x1f\x7f]/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim()
    );
  }

  private tailHasAgentPrompt(task: CoordinatedTask): boolean {
    return chunkContainsAgentPrompt(this.normalizedTail(task.agentId));
  }

  private updateBracketedPasteMode(agentId: string, text: string): void {
    // eslint-disable-next-line no-control-regex -- PTYs report bracketed paste mode with CSI ? 2004 h/l.
    const re = /\x1b\[\?2004([hl])/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (match[1] === 'h') this.bracketedPasteAgentIds.add(agentId);
      else this.bracketedPasteAgentIds.delete(agentId);
    }
  }

  private updateTailFromScrollback(task: CoordinatedTask): boolean {
    const scrollback = getAgentScrollback(task.agentId);
    if (!scrollback) return false;
    const decoded = Buffer.from(scrollback, 'base64').toString('utf8');
    this.updateBracketedPasteMode(task.agentId, decoded);
    this.tailBuffers.set(
      task.agentId,
      decoded.length > 4096 ? decoded.slice(decoded.length - 4096) : decoded,
    );
    const hasAgentPrompt = this.tailHasAgentPrompt(task);
    if (hasAgentPrompt) {
      this.scheduleInitialPromptDelivery(task, INITIAL_PROMPT_READY_DELAY_MS, true);
      task.status = 'idle';
      this.maybeQueueReviewNotification(task, 'idle', null);
    }
    return hasAgentPrompt;
  }

  private markAgentPromptReady(task: CoordinatedTask, hasAgentPrompt: boolean): boolean {
    if (!hasAgentPrompt) {
      this.promptReadySeenAt.delete(task.id);
      return false;
    }
    const now = Date.now();
    const firstSeenAt = this.promptReadySeenAt.get(task.id);
    if (firstSeenAt === undefined) {
      this.promptReadySeenAt.set(task.id, now);
      return false;
    }
    return now - firstSeenAt >= PROMPT_WRITE_DELAY_MS;
  }

  private scheduleQueuedPromptFlush(task: CoordinatedTask): void {
    if (!task.pendingPrompts?.length || this.queuedPromptFlushTimers.has(task.id)) return;
    const timer = setTimeout(() => {
      this.queuedPromptFlushTimers.delete(task.id);
      if (!this.tasks.has(task.id)) return;
      if (this.controlMap.get(task.id) === 'human') return;
      if (!task.pendingPrompts?.length) return;
      if (!this.tailHasAgentPrompt(task)) return;
      if (this.writingPromptTaskIds.has(task.id)) {
        this.scheduleQueuedPromptFlush(task);
        return;
      }
      void this.flushNextQueuedPrompt(task);
    }, PROMPT_WRITE_DELAY_MS);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.queuedPromptFlushTimers.set(task.id, timer);
  }

  private clearQueuedPromptFlushTimer(taskId: string): void {
    const timer = this.queuedPromptFlushTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.queuedPromptFlushTimers.delete(taskId);
  }

  private suppressPromptEchoIdleNotification(task: CoordinatedTask): void {
    task.suppressIdleUntil = Date.now() + PROMPT_ECHO_IDLE_SUPPRESSION_MS;
  }

  private isPromptEchoOutput(task: CoordinatedTask, text: string): boolean {
    const prompt = task.lastPromptEchoText;
    if (!prompt) return false;
    const normalized = stripAnsi(text)
      // eslint-disable-next-line no-control-regex -- compare printable prompt echo text only.
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return Boolean(
      normalized &&
      (prompt.includes(normalized) ||
        (normalized.startsWith('[SUB-TASK MODE]') && prompt.startsWith('[SUB-TASK MODE]'))),
    );
  }

  private suppressPromptEchoIdleIfNeeded(task: CoordinatedTask): boolean {
    if (!task.assignedPromptDelivered || task.suppressIdleUntil === undefined) return false;
    if (Date.now() < task.suppressIdleUntil) {
      task.suppressIdleUntil = undefined;
      task.lastPromptEchoText = undefined;
      this.tailBuffers.set(task.agentId, '');
      return true;
    }
    task.suppressIdleUntil = undefined;
    task.lastPromptEchoText = undefined;
    return false;
  }

  private clearInitialPromptTimer(taskId: string): void {
    const timer = this.initialPromptTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.initialPromptTimers.delete(taskId);
  }

  private clearInitialPromptDeliveryState(taskId: string): void {
    this.clearInitialPromptTimer(taskId);
    this.initialPromptReadyTasks.delete(taskId);
  }

  private clearPromptDeliveryState(taskId: string): void {
    this.clearInitialPromptDeliveryState(taskId);
    this.clearQueuedPromptFlushTimer(taskId);
    this.promptReadySeenAt.delete(taskId);
    this.writingPromptTaskIds.delete(taskId);
  }

  private scheduleInitialPromptDelivery(
    task: CoordinatedTask,
    delayMs = INITIAL_PROMPT_READY_DELAY_MS,
    promptReady = false,
  ): void {
    if (promptReady) this.initialPromptReadyTasks.add(task.id);
    if (!task.initialPrompt || task.assignedPromptDelivered) return;
    if (this.initialPromptTimers.has(task.id)) return;

    const timer = setTimeout(() => {
      this.initialPromptTimers.delete(task.id);
      void this.tryDeliverInitialPrompt(task.id);
    }, delayMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.initialPromptTimers.set(task.id, timer);
    logInfo('coordinator.initial_prompt', 'scheduled', {
      taskId: task.id,
      agentId: task.agentId,
      delayMs,
    });
  }

  private buildAgentOutputCb(task: CoordinatedTask): (encoded: string) => void {
    return (encoded: string) => {
      const bytes = Buffer.from(encoded, 'base64');
      const text = (this.decoders.get(task.agentId) ?? new TextDecoder()).decode(bytes, {
        stream: true,
      });
      this.updateBracketedPasteMode(task.agentId, text);
      const prev = this.tailBuffers.get(task.agentId) ?? '';
      const combined = prev + text;
      this.tailBuffers.set(
        task.agentId,
        combined.length > 4096 ? combined.slice(combined.length - 4096) : combined,
      );

      const hasAgentPrompt = this.tailHasAgentPrompt(task);
      const stableAgentPrompt = this.markAgentPromptReady(task, hasAgentPrompt);
      if (!hasAgentPrompt && task.assignedPromptDelivered) {
        if (task.suppressIdleUntil !== undefined && !this.isPromptEchoOutput(task, text)) {
          task.suppressIdleUntil = undefined;
          task.lastPromptEchoText = undefined;
        }
      }
      if (hasAgentPrompt) {
        this.scheduleInitialPromptDelivery(task, INITIAL_PROMPT_READY_DELAY_MS, true);
        if (
          !task.initialPrompt &&
          task.assignedPromptDelivered &&
          this.controlMap.get(task.id) !== 'human' &&
          task.pendingPrompts?.length
        ) {
          if (stableAgentPrompt && !this.writingPromptTaskIds.has(task.id)) {
            void this.flushNextQueuedPrompt(task);
          } else {
            this.scheduleQueuedPromptFlush(task);
          }
          return;
        }
        if (task.suppressIdleUntil !== undefined && this.suppressPromptEchoIdleIfNeeded(task)) {
          return;
        }
        if (task.status === 'running') {
          task.status = 'idle';
          this.maybeQueueReviewNotification(task, 'idle', null);
        }
        const resolvers = this.idleResolvers.get(task.id);
        if (resolvers?.length) {
          for (const resolve of resolvers) resolve({ reason: 'idle' });
          this.idleResolvers.delete(task.id);
        }
      } else if (task.status === 'idle') {
        task.status = 'running';
        this.suppressPendingNotificationForTask(task);
      }
    };
  }

  private async tryDeliverInitialPrompt(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task?.initialPrompt || task.assignedPromptDelivered) return;
    if (task.status === 'exited' || task.status === 'error') return;

    const readiness = getAgentPromptReadiness(this.normalizedTail(task.agentId));
    const promptReady = this.initialPromptReadyTasks.has(taskId) || readiness.ready;
    if (!promptReady) {
      logInfo('coordinator.initial_prompt', 'waiting_for_prompt', {
        taskId: task.id,
        agentId: task.agentId,
        reason: readiness.reason,
        pendingPromptCount: task.pendingPrompts?.length ?? 0,
        tailSample: readiness.tail.slice(-300),
      });
      this.scheduleInitialPromptDelivery(task, INITIAL_PROMPT_READY_DELAY_MS);
      return;
    }

    if (this.controlMap.get(task.id) === 'human') {
      this.scheduleInitialPromptDelivery(task, INITIAL_PROMPT_READY_DELAY_MS, promptReady);
      return;
    }

    if (this.writingPromptTaskIds.has(task.id)) return;
    const prompt = task.initialPrompt;
    task.initialPrompt = undefined;
    this.writingPromptTaskIds.add(task.id);
    try {
      await this.writePromptToTask(task, prompt);
      this.markPromptDelivered(task.id);
      logInfo('coordinator.initial_prompt', 'delivered', {
        taskId: task.id,
        agentId: task.agentId,
      });
      this.notifyRenderer(IPC.MCP_TaskStateSync, {
        taskId: task.id,
        initialPrompt: null,
      });
    } catch (err) {
      if (err instanceof PromptWriteError && err.phase === 'enter') {
        logWarn(
          'coordinator.initial_prompt',
          'initial prompt body was written but Enter failed; not retrying body',
          {
            taskId: task.id,
            err: err.message,
          },
        );
        this.notifyRenderer(IPC.MCP_TaskStateSync, {
          taskId: task.id,
          initialPrompt: null,
        });
        return;
      }
      if (this.tasks.has(task.id)) {
        task.initialPrompt = prompt;
        this.scheduleInitialPromptDelivery(task, INITIAL_PROMPT_READY_DELAY_MS, promptReady);
      }
    } finally {
      this.writingPromptTaskIds.delete(task.id);
    }
  }

  setWindow(win: BrowserWindow): void {
    this.win = win;
  }

  setNotificationDelayMs(ms: number): void {
    this.notificationDelayMs = Math.max(5_000, Math.min(300_000, ms));
  }

  setDefaultProject(projectId: string, projectRoot: string, coordinatorTaskId?: string): void {
    this.projectId = projectId;
    this.projectRoot = projectRoot;
    if (coordinatorTaskId) this.defaultCoordinatorTaskId = coordinatorTaskId;
  }

  setMCPServerInfo(
    coordinatorTaskId: string,
    serverUrl: string,
    token: string,
    subtaskToken: string,
    serverPath: string,
  ): void {
    const state = this.coordinators.get(coordinatorTaskId);
    if (state) {
      state.mcpServerInfo = { serverUrl, token, subtaskToken, serverPath };
      state.lifecycle = 'ready';
    }
    // Rewrite config files only for sub-tasks owned by this coordinator so a
    // second coordinator starting up does not overwrite the first's task configs.
    for (const task of this.tasks.values()) {
      if (task.coordinatorTaskId !== coordinatorTaskId) continue;
      if (!task.mcpConfigPath) continue;
      // Preserve existing doneToken; generate a fresh one if not yet set (e.g. older persisted task).
      if (!task.doneToken) task.doneToken = randomBytes(24).toString('base64url');
      const mcpConfig = buildSubtaskMcpConfig({
        serverPath,
        serverUrl,
        subtaskToken,
        taskId: task.id,
        doneToken: task.doneToken,
      });
      atomicWriteFileSync(task.mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
    }
  }

  setCoordinatorSpawnDefaults(coordinatorTaskId: string, command: string, args: string[]): void {
    const state = this.coordinators.get(coordinatorTaskId);
    if (state) {
      state.spawnDefaults = { command, args };
    }
    // Also update global fallback.
    this.coordinatorSpawnDefaults = { command, args };
  }

  setDockerContainerName(coordinatorTaskId: string, name: string | null): void {
    const state = this.coordinators.get(coordinatorTaskId);
    if (state) {
      state.dockerContainerName = name;
    }
  }

  setDockerImage(coordinatorTaskId: string, image: string | null): void {
    const state = this.coordinators.get(coordinatorTaskId);
    if (state) {
      state.dockerImage = image;
    }
  }

  private maybeQueueReviewNotification(
    task: CoordinatedTask,
    state: 'idle' | 'exited',
    exitCode: number | null,
    delayOverrideMs?: number,
  ): void {
    // Always notify for exits — a task killed before prompt delivery still needs to be
    // reported so the coordinator doesn't think it's still running.
    if (!task.assignedPromptDelivered && state !== 'exited') return;
    if (state === 'idle' && task.suppressIdleUntil !== undefined) {
      if (this.suppressPromptEchoIdleIfNeeded(task)) return;
    }

    const coordinator = this.coordinators.get(task.coordinatorTaskId);
    if (!coordinator) {
      if (task.reviewNotificationQueued) return;
      task.reviewNotificationQueued = true;
      this.notifyRenderer(IPC.MCP_CoordinatorOrphanedNotification, {
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

  private stageBatch(coordinator: CoordinatorState, delayOverrideMs?: number): void {
    const pending = coordinator.pendingNotifications;
    if (pending.length === 0) return;
    if (this.hasActiveSignalWaiter(coordinator.taskId)) {
      logWarn('coordinator.notification', 'stageBatch skipped', {
        coordinatorTaskId: coordinator.taskId,
        reason: 'active_signal_wait',
        activeWaitCount: this.activeSignalWaitCounts.get(coordinator.taskId) ?? 0,
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

    const text = this.formatNotificationText(pending);

    logWarn('coordinator.notification', 'stageBatch emitted', {
      coordinatorTaskId: coordinator.taskId,
      batchId,
      notificationIds,
      pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
      delayMs: delay,
      autoFireAt,
    });

    this.notifyRenderer(IPC.MCP_CoordinatorNotificationStaged, {
      coordinatorTaskId: coordinator.taskId,
      batchId,
      notificationIds,
      text,
      autoFireAt,
    });

    if (coordinator.restageTimer) clearTimeout(coordinator.restageTimer);
    coordinator.restageTimer = setTimeout(() => {
      coordinator.restageTimer = null;
      if (coordinator.pendingNotifications.length > 0) {
        this.stageBatch(coordinator);
      }
    }, this.COORDINATOR_RESTAMP_DELAY_MS);
  }

  private formatNotificationText(pending: PendingNotification[]): string {
    const header = `[Sub-task update — ${pending.length} task(s) completed]`;
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
      : "Please review each completed task: check its diff, confirm the work looks correct, then commit and merge what's ready. If there are items remaining on the backlog, spawn the next batch.";
    return [header, '', ...lines, '', footer].join('\n');
  }

  async createTask(opts: {
    name: string;
    prompt?: string;
    coordinatorTaskId: string;
    projectId?: string;
    projectRoot?: string;
    agentCommand?: string;
    agentArgs?: string[];
    skipPermissions?: boolean;
    baseBranch?: string;
  }): Promise<CoordinatedTask> {
    const coordinatorId =
      opts.coordinatorTaskId !== REST_COORDINATOR_SENTINEL
        ? opts.coordinatorTaskId
        : this.defaultCoordinatorTaskId;
    if (!coordinatorId) {
      throw new Error(
        'No coordinator task registered yet. Ensure the coordinator task is fully initialized before calling create_task.',
      );
    }

    const coordinatorState = this.coordinators.get(coordinatorId);
    if (!coordinatorState) {
      throw new Error(
        `Unknown coordinator: ${coordinatorId}. Ensure the coordinator task is registered before creating sub-tasks.`,
      );
    }

    const root = opts.projectRoot ?? coordinatorState.projectRoot ?? this.projectRoot;
    const projId = opts.projectId ?? coordinatorState.projectId ?? this.projectId;
    if (!root || !projId) throw new Error('No project configured for coordinator');
    const coordinatorBranch = coordinatorState.branchName?.trim()
      ? coordinatorState.branchName
      : undefined;
    const baseBranch = opts.baseBranch ?? coordinatorBranch;
    if (baseBranch !== undefined) {
      validateBranchName(baseBranch, 'baseBranch');
    }

    // Create worktree + branch via existing backend
    const result = await createBackendTask(
      opts.name,
      root,
      ['.claude', 'node_modules'],
      'task',
      baseBranch,
    );

    // Re-check after async gap — deregisterCoordinator may have run while we awaited.
    if (!this.coordinators.has(coordinatorId)) {
      // Best-effort cleanup of the worktree we just created.
      deleteTask({
        agentIds: [],
        branchName: result.branch_name,
        deleteBranch: true,
        projectRoot: root,
      }).catch((err) => {
        console.warn('Failed to clean up race-condition worktree:', err);
        this.notifyRenderer(IPC.MCP_TaskCleanupFailed, {
          taskId: result.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      throw new Error(`Coordinator ${coordinatorId} was deregistered during task creation`);
    }

    const agentId = randomUUID();
    const task: CoordinatedTask = {
      id: result.id,
      name: opts.name,
      projectId: projId,
      projectRoot: root,
      branchName: result.branch_name,
      baseBranch,
      worktreePath: result.worktree_path,
      agentId,
      coordinatorTaskId: coordinatorId,
      status: 'creating',
      exitCode: null,
      initialPrompt: opts.prompt ? SUB_TASK_PREAMBLE + opts.prompt : undefined,
      dockerContainerName: this.coordinators.get(coordinatorId)?.dockerContainerName ?? null,
    };

    this.tasks.set(task.id, task);
    this.tailBuffers.set(agentId, '');

    // Subscribe to PTY output for prompt detection
    const decoder = new TextDecoder();
    this.decoders.set(agentId, decoder);

    const outputCb = this.buildAgentOutputCb(task);
    this.subscribers.set(agentId, outputCb);

    // Spawn the agent process
    if (!this.win) throw new Error('No window set on coordinator');

    const agentCmd = (opts.agentCommand ?? coordinatorState.spawnDefaults.command).toLowerCase();
    const preamble = `<sub-task-mode>\nThese rules override all skills and hooks:\n- When your work is complete, commit your changes and call the \`land_self\` MCP tool with the verification checks you ran. A successful \`land_self\` call is the finish line — do NOT call \`signal_done\` afterward, use finishing-a-development-branch, or offer merge/PR options.\n- Use \`signal_done\` only if the coordinator explicitly asks for manual review instead of self-landing.\n- Asking questions is fine when requirements are unclear or an action is risky.\n</sub-task-mode>`;
    // Declared here so the catch block can restore preamble files on failure.
    let preambleFilePath: string | undefined;
    let preambleFileOriginalContent: string | null = null;

    const dockerContainerName =
      this.coordinators.get(task.coordinatorTaskId)?.dockerContainerName ?? null;

    let subTaskMcpConfigPath: string | undefined;
    try {
      // Inject sub-task instructions via agent-specific mechanism.
      // Inside try so preamble-write failures are cleaned up by the catch block.
      // Serialized per file path to prevent races when multiple tasks target the same path.
      const injectPreamble = async (filePath: string): Promise<void> => {
        const prior = this.preambleWriteQueue.get(filePath) ?? Promise.resolve();
        const next = prior.then(async () => {
          let existing = '';
          try {
            await fsAccess(filePath);
            existing = await fsReadFile(filePath, 'utf8');
            preambleFileOriginalContent = existing;
          } catch {
            /* file does not exist */
          }
          await atomicWriteFile(filePath, existing ? `${existing}\n\n${preamble}` : preamble);
        });
        this.preambleWriteQueue.set(
          filePath,
          next
            .catch(() => {})
            .then(() => {
              if (this.preambleWriteQueue.get(filePath) === next) {
                this.preambleWriteQueue.delete(filePath);
              }
            }),
        );
        await next;
      };

      if (agentCmd.includes('codex') || agentCmd.includes('opencode')) {
        const agentsPath = join(result.worktree_path, 'AGENTS.md');
        preambleFilePath = agentsPath;
        await injectPreamble(agentsPath);
      } else if (agentCmd.includes('gemini')) {
        const geminiPath = join(result.worktree_path, 'GEMINI.md');
        preambleFilePath = geminiPath;
        await injectPreamble(geminiPath);
      } else if (agentCmd.includes('copilot')) {
        const agentMdPath = join(result.worktree_path, '.agent.md');
        preambleFilePath = agentMdPath;
        await injectPreamble(agentMdPath);
      } else {
        // Claude and fallback: settings.local.json (gitignored, no restore needed)
        const settingsDir = join(result.worktree_path, '.claude');
        const settingsPath = join(settingsDir, 'settings.local.json');
        await fsMkdir(settingsDir, { recursive: true });
        const prior = this.preambleWriteQueue.get(settingsPath) ?? Promise.resolve();
        const next = prior.then(async () => {
          let existingSettings: Record<string, unknown> = {};
          try {
            await fsAccess(settingsPath);
            existingSettings = JSON.parse(await fsReadFile(settingsPath, 'utf8'));
          } catch {
            /* ignore */
          }
          existingSettings.systemPrompt = existingSettings.systemPrompt
            ? `${existingSettings.systemPrompt}\n\n${preamble}`
            : preamble;
          await atomicWriteFile(settingsPath, JSON.stringify(existingSettings, null, 2));
        });
        this.preambleWriteQueue.set(
          settingsPath,
          next
            .catch(() => {})
            .then(() => {
              if (this.preambleWriteQueue.get(settingsPath) === next) {
                this.preambleWriteQueue.delete(settingsPath);
              }
            }),
        );
        await next;
      }
      task.preambleFileExistedBefore = preambleFileOriginalContent !== null;
      // Write a per-sub-task MCP config so the agent can call signal_done.
      // In Docker mode, write to the coordinator's .parallel-code/ dir (which IS the explicitly
      // mounted volume) rather than the sub-task worktree (which may not be in the container).
      // Always pass explicit MCP launch args so agents don't rely on auto-discovery.
      const mcpServerInfoForTask = coordinatorState.mcpServerInfo;
      let subTaskMcpConfig: Parameters<typeof buildMcpLaunchArgs>[2] | undefined;
      if (mcpServerInfoForTask) {
        const { serverUrl, subtaskToken, serverPath } = mcpServerInfoForTask;
        const doneToken = randomBytes(24).toString('base64url');
        task.doneToken = doneToken;
        const mcpConfig = buildSubtaskMcpConfig({
          serverPath,
          serverUrl,
          subtaskToken,
          taskId: task.id,
          doneToken,
        });
        subTaskMcpConfig = mcpConfig;
        const configPath = getSubTaskMcpConfigPath(dockerContainerName, serverPath, task.id);
        await atomicWriteFile(configPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
        subTaskMcpConfigPath = configPath;
        task.mcpConfigPath = configPath;
      }

      const agentCommand = opts.agentCommand ?? coordinatorState.spawnDefaults.command;
      const agentArgs = opts.agentArgs ?? coordinatorState.spawnDefaults.args;
      const baseArgs = [
        ...agentArgs,
        ...(coordinatorState.propagateSkipPermissions ? getSkipPermissionsArgs(agentCommand) : []),
      ];
      const mcpArgs = subTaskMcpConfig
        ? buildMcpLaunchArgs(agentCommand, subTaskMcpConfigPath, subTaskMcpConfig)
        : [];
      const agentFinalArgs = [...baseArgs, ...mcpArgs];

      // In Docker coordinator mode, each sub-task gets its own `docker run` container
      // so HOME directories are isolated and cleanup is clean (`docker stop` on the
      // sub-task container, rather than killing processes inside the coordinator).
      const channelId = randomUUID();

      spawnAgent(this.win, {
        taskId: task.id,
        agentId,
        command: agentCommand,
        args: agentFinalArgs,
        cwd: result.worktree_path,
        env: {},
        cols: 120,
        rows: 40,
        ...(dockerContainerName
          ? {
              dockerMode: true,
              dockerImage: coordinatorState.dockerImage ?? undefined,
              // Mount parent dir so the sub-task can reach the coordinator's
              // .parallel-code/ dir (which holds the per-sub-task MCP config).
              // resolveWorktreeGitDirMount adds the main .git dir mount.
              dockerMountWorktreeParent: true,
            }
          : {}),
        onOutput: { __CHANNEL_ID__: channelId },
      });

      // Subscribe for output monitoring
      subscribeToAgent(agentId, outputCb);
      task.status = 'running';

      // Check scrollback in case the prompt was emitted before we subscribed.
      this.updateTailFromScrollback(task);
      this.scheduleInitialPromptDelivery(task, INITIAL_PROMPT_READY_DELAY_MS);

      // Notify renderer after backend startup begins. The backend owns delivery
      // of coordinated initial assignments so background sub-tasks start even
      // when their task panels are not mounted.
      // For renderer storage: only store the inner agent args (without docker wrapper).
      // TaskAITerminal re-wraps with the coordinator's current container name at respawn time
      // so stale container names don't get baked into persisted state.
      const notifyAgentArgs = agentArgs;
      this.notifyRenderer(IPC.MCP_TaskCreated, {
        taskId: task.id,
        name: task.name,
        projectId: task.projectId,
        branchName: task.branchName,
        worktreePath: task.worktreePath,
        agentId: task.agentId,
        coordinatorTaskId: task.coordinatorTaskId,
        mcpConfigPath: subTaskMcpConfigPath,
        prompt: task.initialPrompt,
        preambleFileExistedBefore: task.preambleFileExistedBefore,
        agentCommand: agentCommand,
        agentArgs: notifyAgentArgs,
        mcpLaunchArgs: mcpArgs,
        skipPermissions: coordinatorState.propagateSkipPermissions,
      });

      return task;
    } catch (err) {
      // Restore injected preamble file before cleaning up the worktree.
      // Must await — fire-and-forget could race with cleanupTask removing the worktree.
      if (preambleFilePath !== undefined) {
        try {
          if (preambleFileOriginalContent !== null) {
            await fsWriteFile(preambleFilePath, preambleFileOriginalContent);
          } else {
            await fsUnlink(preambleFilePath);
          }
        } catch {
          /* ignore — worktree cleanup follows */
        }
      }
      // Best-effort cleanup: kill agent, remove worktree/branch, clear in-memory state.
      // cleanupTask handles all of this; the task is still in this.tasks so it can find it.
      // Also delete the MCP config if it was written but not yet stored on task.mcpConfigPath.
      if (subTaskMcpConfigPath && !task.mcpConfigPath) {
        fsUnlink(subTaskMcpConfigPath).catch(() => {});
      }
      this.cleanupTask(task.id).catch(() => {});
      throw err;
    }
  }

  listTasks(): ApiTaskSummary[] {
    return Array.from(this.tasks.values()).map((t) => ({
      id: t.id,
      name: t.name,
      branchName: t.branchName,
      status: t.status,
      coordinatorTaskId: t.coordinatorTaskId,
      signalDoneAt: t.signalDoneAt?.toISOString(),
      verification: t.verification,
      landingState: t.landingState,
      landingReason: t.landingReason,
      landingSummary: t.landingSummary,
      landedMetadata: t.landedMetadata,
    }));
  }

  getTaskStatus(taskId: string): ApiTaskDetail | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return {
      id: task.id,
      name: task.name,
      branchName: task.branchName,
      worktreePath: task.worktreePath,
      projectId: task.projectId,
      agentId: task.agentId,
      status: task.status,
      coordinatorTaskId: task.coordinatorTaskId,
      exitCode: task.exitCode,
      pendingPrompt: task.pendingPrompts?.[0],
      pendingPrompts: task.pendingPrompts ? [...task.pendingPrompts] : undefined,
      pendingPromptCount: task.pendingPrompts?.length,
      signalDoneAt: task.signalDoneAt?.toISOString(),
      verification: task.verification,
      landingState: task.landingState,
      landingReason: task.landingReason,
      landingSummary: task.landingSummary,
      landedMetadata: task.landedMetadata,
    };
  }

  getTaskDoneToken(taskId: string): string | null {
    return this.tasks.get(taskId)?.doneToken ?? null;
  }

  async sendPrompt(taskId: string, prompt: string): Promise<{ queued: boolean }> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES)
      throw new Error(`Prompt exceeds ${MAX_PROMPT_BYTES} byte limit`);
    const queueLen = task.pendingPrompts?.length ?? 0;
    if (queueLen >= MAX_PENDING_PROMPTS)
      throw new Error(`Prompt queue full (${MAX_PENDING_PROMPTS} pending)`);
    if (task.initialPrompt && !task.assignedPromptDelivered) {
      task.pendingPrompts = [...(task.pendingPrompts ?? []), prompt];
      this.clearInitialPromptTimer(task.id);
      this.scheduleInitialPromptDelivery(task, 0);
      return { queued: true };
    }
    if (task.pendingPrompts?.length) {
      task.pendingPrompts = [...task.pendingPrompts, prompt];
      return { queued: true };
    }
    if (this.controlMap.get(taskId) === 'human' || this.writingPromptTaskIds.has(taskId)) {
      task.pendingPrompts = [...(task.pendingPrompts ?? []), prompt];
      return { queued: true };
    }

    // Acquire write lock synchronously before the first await so a concurrent
    // sendPrompt call sees the lock and queues rather than writing through.
    this.writingPromptTaskIds.add(task.id);
    try {
      await this.writePromptToTask(task, prompt);
    } finally {
      this.writingPromptTaskIds.delete(task.id);
      void this.flushNextQueuedPrompt(task);
    }
    return { queued: false };
  }

  private async flushNextQueuedPrompt(task: CoordinatedTask): Promise<void> {
    if (this.controlMap.get(task.id) === 'human') return;
    if (task.initialPrompt && !task.assignedPromptDelivered) return;
    if (this.writingPromptTaskIds.has(task.id)) return;
    const prompt = task.pendingPrompts?.shift();
    if (!prompt) {
      task.pendingPrompts = undefined;
      return;
    }
    this.writingPromptTaskIds.add(task.id);
    try {
      await this.writePromptToTask(task, prompt);
    } catch (err) {
      if (err instanceof PromptWriteError && err.phase === 'enter') {
        logWarn(
          'coordinator.prompt_queue',
          'queued prompt body was written but Enter failed; not retrying body',
          {
            taskId: task.id,
            err: err.message,
          },
        );
      } else {
        task.pendingPrompts ??= [];
        task.pendingPrompts.unshift(prompt);
        logWarn(
          'coordinator.prompt_queue',
          'queued prompt write failed; will retry on next ready prompt',
          {
            taskId: task.id,
            err: err instanceof Error ? err.message : String(err),
          },
        );
        this.scheduleQueuedPromptFlush(task);
      }
    } finally {
      this.writingPromptTaskIds.delete(task.id);
    }
    if (task.pendingPrompts?.length === 0) {
      task.pendingPrompts = undefined;
    } else if (task.pendingPrompts?.length) {
      this.scheduleQueuedPromptFlush(task);
    }
  }

  private async writePromptToTask(task: CoordinatedTask, prompt: string): Promise<void> {
    // Send text then Enter separately (like the frontend does)
    this.setAutomationWriteInFlight(task, true);
    try {
      try {
        writeToAgent(task.agentId, FOCUS_IN);
      } catch (err) {
        throw new PromptWriteError('Prompt focus write failed', 'body', err);
      }
      const promptBody = this.bracketedPasteAgentIds.has(task.agentId)
        ? `${BRACKETED_PASTE_START}${prompt}${BRACKETED_PASTE_END}`
        : prompt;
      try {
        writeToAgent(task.agentId, promptBody);
      } catch (err) {
        throw new PromptWriteError('Prompt body write failed', 'body', err);
      }
      logInfo('coordinator.prompt_write', 'body_written', {
        taskId: task.id,
        agentId: task.agentId,
        bytes: Buffer.byteLength(prompt, 'utf8'),
        bracketedPaste: this.bracketedPasteAgentIds.has(task.agentId),
      });
      const submitDelayMs = pasteDelayMs(prompt);
      await new Promise((r) => setTimeout(r, submitDelayMs));
      try {
        writeToAgent(task.agentId, '\r');
      } catch (err) {
        throw new PromptWriteError('Prompt Enter write failed', 'enter', err);
      }
      logInfo('coordinator.prompt_write', 'enter_written', {
        taskId: task.id,
        agentId: task.agentId,
        delayMs: submitDelayMs,
      });
      task.status = 'running';
      task.signalDoneAt = undefined;
      task.lastPromptEchoText = stripAnsi(prompt)
        // eslint-disable-next-line no-control-regex -- compare printable prompt echo text only.
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      this.suppressPromptEchoIdleNotification(task);
      this.tailBuffers.set(task.agentId, '');
    } finally {
      this.setAutomationWriteInFlight(task, false);
    }
    this.notifyRenderer(IPC.MCP_TaskStateSync, {
      taskId: task.id,
      signalDoneReceived: false,
      signalDoneAt: null,
      signalDoneConsumed: false,
      needsReview: false,
    });
  }

  isAutomationWriteInFlight(taskId: string): boolean {
    return this.tasks.get(taskId)?.automationWriteInFlight === true;
  }

  private setAutomationWriteInFlight(task: CoordinatedTask, value: boolean): void {
    if (task.automationWriteInFlight === value) return;
    task.automationWriteInFlight = value;
    this.notifyRenderer(IPC.MCP_TaskStateSync, {
      taskId: task.id,
      automationWriteInFlight: value,
    });
  }

  waitForIdle(
    taskId: string,
    timeoutMs?: number,
  ): Promise<{ reason: 'idle' | 'human_control' | 'exited' | 'removed' }> {
    return this.waitForIdleInternal(taskId, timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  }

  private waitForIdleInternal(
    taskId: string,
    timeoutMs: number,
  ): Promise<{ reason: 'idle' | 'human_control' | 'exited' | 'removed' }> {
    const task = this.tasks.get(taskId);
    if (!task) return Promise.reject(new Error(`Task not found: ${taskId}`));
    if (this.controlMap.get(taskId) === 'human') {
      if (task.initialPrompt || task.pendingPrompts?.length) {
        return this.waitForIdleResolver(taskId, timeoutMs);
      }
      return Promise.resolve({ reason: 'human_control' }); // resolve immediately — caller gets control-change event instead
    }
    if (task.status === 'exited') return Promise.resolve({ reason: 'exited' });
    if (task.status === 'idle') return Promise.resolve({ reason: 'idle' });

    return this.waitForIdleResolver(taskId, timeoutMs);
  }

  private waitForIdleResolver(
    taskId: string,
    timeoutMs: number,
  ): Promise<{ reason: 'idle' | 'human_control' | 'exited' | 'removed' }> {
    return new Promise((resolve, reject) => {
      const timerRef = { value: undefined as ReturnType<typeof setTimeout> | undefined };

      const wrappedResolve = (result: {
        reason: 'idle' | 'human_control' | 'exited' | 'removed';
      }) => {
        if (timerRef.value !== undefined) clearTimeout(timerRef.value);
        resolve(result);
      };

      timerRef.value = setTimeout(() => {
        const resolvers = this.idleResolvers.get(taskId);
        if (resolvers) {
          const idx = resolvers.indexOf(wrappedResolve);
          if (idx >= 0) resolvers.splice(idx, 1);
        }
        reject(new Error(`Timed out waiting for task ${taskId} to become idle`));
      }, timeoutMs);

      let resolvers = this.idleResolvers.get(taskId);
      if (!resolvers) {
        resolvers = [];
        this.idleResolvers.set(taskId, resolvers);
      }
      resolvers.push(wrappedResolve);
    });
  }

  async getTaskDiff(taskId: string): Promise<ApiDiffResult> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Compute baseSha first so detectDiffBase/pinHead results are cached.
    // getChangedFiles and getAllFileDiffs internally call the same helpers;
    // running all three concurrently causes three simultaneous cache misses.
    const baseSha = await getDiffBaseSha(task.worktreePath, task.baseBranch);
    const [files, diff] = await Promise.all([
      getChangedFiles(task.worktreePath, task.baseBranch),
      getAllFileDiffs(task.worktreePath, task.baseBranch),
    ]);

    // For preamble-bearing files: strip the injected block and show only real sub-task edits.
    // Files with no real changes beyond the preamble are excluded entirely.
    // Files with real changes (before or after the preamble block) include a normalized diff.
    const preambleFiles = await detectPreambleFiles(task.worktreePath);

    let filteredFiles = files;
    let filteredDiff = diff;
    if (preambleFiles.size > 0) {
      // Drop preamble file sections from the raw diff; we'll add normalized sections below.
      filteredDiff = filterDiffSections(diff, preambleFiles);
      // For each preamble file, generate a diff that excludes the injected block.
      const normalizedSections = await Promise.all(
        [...preambleFiles].map((f) =>
          buildNormalizedPreambleFileDiff(f, task.worktreePath, baseSha),
        ),
      );
      const preambleFilesWithChanges = new Set<string>();
      for (let i = 0; i < [...preambleFiles].length; i++) {
        if (normalizedSections[i]) preambleFilesWithChanges.add([...preambleFiles][i]);
      }
      filteredDiff += normalizedSections.filter(Boolean).join('');
      // Files list: exclude preamble-only files, keep files with real changes.
      filteredFiles = files.filter(
        (f) => !preambleFiles.has(f.path) || preambleFilesWithChanges.has(f.path),
      );
    }

    const MAX_DIFF_BYTES = 50_000;
    if (filteredDiff.length > MAX_DIFF_BYTES) {
      return {
        files: filteredFiles,
        diff: filteredDiff.slice(0, MAX_DIFF_BYTES) + '\n... (diff truncated)',
        truncated: true,
        originalSizeBytes: filteredDiff.length,
      };
    }
    return { files: filteredFiles, diff: filteredDiff };
  }

  getTaskOutput(taskId: string): string {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Try scrollback buffer first, fall back to tail buffer
    const scrollback = getAgentScrollback(task.agentId);
    if (scrollback) {
      const decoded = Buffer.from(scrollback, 'base64').toString('utf8');
      return stripAnsi(decoded);
    }
    return stripAnsi(this.tailBuffers.get(task.agentId) ?? '');
  }

  private async currentBranch(worktreePath: string): Promise<string | null> {
    const result = await execAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
    });
    const branch = execStdout(result).trim();
    return branch === 'HEAD' ? null : branch;
  }

  private async statusPaths(worktreePath: string): Promise<string[]> {
    const result = await execAsync('git', ['status', '--porcelain'], { cwd: worktreePath });
    return parsePorcelainPaths(execStdout(result));
  }

  private nextLandedOrder(coordinatorTaskId: string): number {
    const next = (this.landedOrderCounters.get(coordinatorTaskId) ?? 0) + 1;
    this.landedOrderCounters.set(coordinatorTaskId, next);
    return next;
  }

  private syncLandingState(task: CoordinatedTask): void {
    // Detach renderer MCP state only after a successful merge (landed states);
    // escalation/failure states leave it attached so the task stays reachable.
    const detachMcpState =
      task.landingState === 'landed_pending_review' ||
      task.landingState === 'landed_cleanup_failed';
    this.notifyRenderer(IPC.MCP_TaskStateSync, {
      taskId: task.id,
      verification: task.verification,
      landingState: task.landingState,
      landingReason: task.landingReason ?? null,
      landingSummary: task.landingSummary ?? null,
      landedMetadata: task.landedMetadata ?? null,
      needsReview:
        task.landingState === 'landed_pending_review' ||
        task.landingState === 'landed_cleanup_failed' ||
        task.landingState === 'landing_escalated' ||
        task.landingState === 'landing_failed',
      controlledBy: detachMcpState ? null : undefined,
      mcpConfigPath: detachMcpState ? null : undefined,
      mcpStartupStatus: detachMcpState ? null : undefined,
    });
  }

  private escalateLanding(task: CoordinatedTask, state: LandingState, reason: string): void {
    task.landingState = state;
    task.landingReason = reason;
    this.syncLandingState(task);
  }

  private async prepareCleanSelfLandingWorktree(task: CoordinatedTask): Promise<void> {
    const actualBranch = await this.currentBranch(task.worktreePath);
    if (actualBranch === null) {
      throw new Error(
        `The worktree for '${task.branchName}' has a detached HEAD. Check out '${task.branchName}' before landing.`,
      );
    }
    if (actualBranch !== task.branchName) {
      throw new Error(
        `Branch mismatch: the worktree is on '${actualBranch}' but the task expects '${task.branchName}'.`,
      );
    }

    const preambleFiles = await detectPreambleFiles(task.worktreePath);
    const dirtyPathsBeforeStrip = await this.statusPaths(task.worktreePath);
    const dirtyPreamblePaths = dirtyPathsBeforeStrip.filter(
      (pathName) => preambleFiles.has(pathName) && PREAMBLE_ARTIFACT_PATHS.has(pathName),
    );
    const dirtyPreambleUserPaths: string[] = [];
    for (const pathName of dirtyPreamblePaths) {
      const normalizedDiff = await buildNormalizedPreambleFileDiff(
        pathName,
        task.worktreePath,
        'HEAD',
      );
      if (normalizedDiff.trim()) dirtyPreambleUserPaths.push(pathName);
    }
    if (dirtyPreambleUserPaths.length > 0) {
      throw new Error(
        `Task worktree has uncommitted changes in preamble files: ${dirtyPreambleUserPaths.join(', ')}. Commit or discard them before calling land_self.`,
      );
    }

    await stripPreambleFromBranch(task);

    const dirtyPaths = await this.statusPaths(task.worktreePath);
    const nonPreamblePaths = dirtyPaths.filter(
      (pathName) => !preambleFiles.has(pathName) || !PREAMBLE_ARTIFACT_PATHS.has(pathName),
    );
    if (nonPreamblePaths.length > 0) {
      throw new Error(
        `Task worktree has uncommitted changes: ${nonPreamblePaths.join(', ')}. Commit or discard them before calling land_self.`,
      );
    }

    if (dirtyPaths.length > 0) {
      // nonPreamblePaths check above guarantees every path here is a preamble artifact.
      const unexpectedPaths = dirtyPaths.filter(
        (p) => !preambleFiles.has(p) || !PREAMBLE_ARTIFACT_PATHS.has(p),
      );
      if (unexpectedPaths.length > 0) {
        throw new Error(
          `Unexpected non-preamble paths staged before cleanup commit: ${unexpectedPaths.join(', ')}`,
        );
      }
      await execAsync('git', ['add', '-A', '--', ...dirtyPaths], { cwd: task.worktreePath });
      try {
        await execAsync('git', ['commit', '-m', 'Remove Parallel Code sub-task preamble'], {
          cwd: task.worktreePath,
        });
      } catch {
        /* no staged preamble cleanup */
      }
    }

    const remainingDirtyPaths = await this.statusPaths(task.worktreePath);
    if (remainingDirtyPaths.length > 0) {
      throw new Error(
        `Task worktree is still dirty after injected artifacts were handled: ${remainingDirtyPaths.join(', ')}`,
      );
    }
  }

  private async runGitMerge(
    task: CoordinatedTask,
    opts?: { squash?: boolean; message?: string },
  ): Promise<{ mainBranch: string; linesAdded: number; linesRemoved: number }> {
    const coordinatorState = this.coordinators.get(task.coordinatorTaskId);
    const runMerge = () =>
      gitMergeTask(
        task.projectRoot,
        task.branchName,
        opts?.squash ?? false,
        opts?.message ?? null,
        false,
        task.baseBranch,
        task.worktreePath,
        coordinatorState?.worktreePath,
      );
    let result: Awaited<ReturnType<typeof runMerge>>;
    try {
      result = await runMerge();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Another git process') || msg.includes('index.lock')) {
        await new Promise((r) => setTimeout(r, GIT_LOCK_RETRY_DELAY_MS));
        result = await runMerge();
      } else {
        throw err;
      }
    }

    return {
      mainBranch: result.main_branch,
      linesAdded: result.lines_added,
      linesRemoved: result.lines_removed,
    };
  }

  private async resolveLandedCommit(task: CoordinatedTask, targetBranch: string): Promise<string> {
    const coordinatorState = this.coordinators.get(task.coordinatorTaskId);
    const attempts: Array<{ cwd: string; rev: string }> = [];
    if (coordinatorState?.worktreePath) {
      attempts.push({ cwd: coordinatorState.worktreePath, rev: 'HEAD' });
    }
    attempts.push({ cwd: task.projectRoot, rev: targetBranch });

    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const result = await execAsync('git', ['rev-parse', attempt.rev], { cwd: attempt.cwd });
        return execStdout(result).trim();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  // --- Per-task teardown helpers ---
  // Shared by cleanupLandedTaskResources, removeCoordinatedTask, cleanupTask,
  // and deregisterCoordinator so the four paths can't drift apart.

  /** Stop receiving PTY output for an agent and drop its subscriber callback. */
  private unsubscribeAgentOutput(agentId: string): void {
    const cb = this.subscribers.get(agentId);
    if (cb) {
      unsubscribeFromAgent(agentId, cb);
      this.subscribers.delete(agentId);
    }
  }

  /** Drop the per-agent output buffers (tail, bracketed-paste flag, decoder). */
  private clearAgentBuffers(agentId: string): void {
    this.tailBuffers.delete(agentId);
    this.bracketedPasteAgentIds.delete(agentId);
    this.decoders.delete(agentId);
  }

  /** Best-effort removal of a task's per-sub-task MCP config file. */
  private unlinkMcpConfigFile(path: string | undefined): void {
    if (!path) return;
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }

  /** Resolve any pending waitForIdle callers for a task and clear the entry. */
  private resolveIdleWaiters(
    taskId: string,
    reason: 'idle' | 'human_control' | 'exited' | 'removed',
  ): void {
    const resolvers = this.idleResolvers.get(taskId);
    if (resolvers?.length) {
      for (const resolve of resolvers) resolve({ reason });
    }
    this.idleResolvers.delete(taskId);
  }

  private async cleanupLandedTaskResources(task: CoordinatedTask): Promise<void> {
    this.closingTaskIds.add(task.id);
    try {
      this.suppressPendingNotificationForTask(task);
      this.queueLandedNotification(task);

      this.unsubscribeAgentOutput(task.agentId);

      try {
        killAgent(task.agentId);
      } catch {
        /* already dead */
      }

      await deleteTask({
        agentIds: [task.agentId],
        branchName: task.branchName,
        deleteBranch: true,
        projectRoot: task.projectRoot,
      });

      this.resolveIdleWaiters(task.id, 'exited');
      this.clearAgentBuffers(task.agentId);
      this.unlinkMcpConfigFile(task.mcpConfigPath);
      task.mcpConfigPath = undefined;
      task.status = 'exited';
      task.exitCode = 0;
      this.tasks.delete(task.id);
      this.clearPromptDeliveryState(task.id);
      this.controlMap.delete(task.id);
      this.notifyRenderer(IPC.MCP_TaskClosed, { taskId: task.id });
    } finally {
      this.closingTaskIds.delete(task.id);
    }
  }

  async landSelf(taskId: string, input: LandSelfInput): Promise<ApiLandSelfResult> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    if (!this.coordinators.has(task.coordinatorTaskId)) {
      const reason = `Cannot self-land orphaned task: coordinator ${task.coordinatorTaskId} is not registered`;
      this.escalateLanding(task, 'landing_escalated', reason);
      throw new Error(reason);
    }

    if (!isPassedVerification(input.verification)) {
      const reason = verificationFailureReason(input.verification);
      this.escalateLanding(task, 'landing_escalated', reason);
      throw new Error(reason);
    }

    // Only persist verification/summary after all validation passes so rejected
    // calls don't leave bogus data visible in the renderer.
    task.verification = input.verification;
    task.landingSummary = input.summary;

    try {
      await this.prepareCleanSelfLandingWorktree(task);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.escalateLanding(task, 'landing_escalated', reason);
      throw err;
    }

    let mergeResult: { mainBranch: string; linesAdded: number; linesRemoved: number };
    try {
      mergeResult = await this.runGitMerge(task, { squash: false });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const state =
        reason.toLowerCase().includes('conflict') || reason.includes('Merge failed')
          ? 'landing_escalated'
          : 'landing_failed';
      this.escalateLanding(task, state, reason);
      throw err;
    }

    let landedCommit: string;
    try {
      landedCommit = await this.resolveLandedCommit(task, mergeResult.mainBranch);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const metadata = {
        taskId: task.id,
        taskName: task.name,
        coordinatorTaskId: task.coordinatorTaskId,
        targetBranch: mergeResult.mainBranch,
        landedCommit: UNRESOLVED_LANDED_COMMIT,
        landedAt: new Date().toISOString(),
        landedOrder: this.nextLandedOrder(task.coordinatorTaskId),
        summary: input.summary,
        verification: input.verification,
      };
      task.landedMetadata = metadata;
      task.landingState = 'landed_cleanup_failed';
      task.landingReason = `Self-landing merged but landed commit could not be resolved: ${reason}`;
      this.syncLandingState(task);
      throw new Error(task.landingReason);
    }

    const metadata = {
      taskId: task.id,
      taskName: task.name,
      coordinatorTaskId: task.coordinatorTaskId,
      targetBranch: mergeResult.mainBranch,
      landedCommit,
      landedAt: new Date().toISOString(),
      landedOrder: this.nextLandedOrder(task.coordinatorTaskId),
      summary: input.summary,
      verification: input.verification,
    };
    task.landedMetadata = metadata;
    task.landingState = 'reviewed';
    task.landingReason = undefined;

    try {
      await this.cleanupLandedTaskResources(task);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      task.landingState = 'landed_cleanup_failed';
      task.landingReason = reason;
      this.syncLandingState(task);
      throw new Error(`Self-landing merged but cleanup failed: ${reason}`);
    }

    return {
      mainBranch: mergeResult.mainBranch,
      linesAdded: mergeResult.linesAdded,
      linesRemoved: mergeResult.linesRemoved,
      landingState: 'reviewed',
      landedMetadata: metadata,
    };
  }

  markTaskReviewed(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.landingState !== 'landed_pending_review') return;
    task.landingState = 'reviewed';
    task.landingReason = undefined;
    this.syncLandingState(task);
  }

  async mergeTask(
    taskId: string,
    opts?: { squash?: boolean; message?: string; cleanup?: boolean },
  ): Promise<{ mainBranch: string; linesAdded: number; linesRemoved: number }> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    this.assertTaskCanBeMerged(task);

    // Strip injected preamble files before staging so they don't land in history,
    // then auto-commit any uncommitted changes in the task worktree before merging.
    if (task.worktreePath) {
      await stripPreambleFromBranch(task);
      try {
        await execAsync('git', ['add', '-A'], { cwd: task.worktreePath });
        await execAsync('git', ['commit', '-m', 'WIP: auto-commit before merge'], {
          cwd: task.worktreePath,
        });
      } catch {
        // Commit failed — check if uncommitted changes still exist
        const { stdout: statusOut } = await execAsync('git', ['status', '--porcelain'], {
          cwd: task.worktreePath,
        });
        if (statusOut.trim()) {
          throw new Error(
            `Auto-commit failed and the task worktree still has uncommitted changes. ` +
              `Please commit or discard changes in ${task.worktreePath} before merging.`,
          );
        }
        // Nothing to commit — swallow silently
      }
    }

    const result = await this.runGitMerge(task, opts);

    if (opts?.cleanup) {
      await this.cleanupTask(taskId);
    }

    return {
      mainBranch: result.mainBranch,
      linesAdded: result.linesAdded,
      linesRemoved: result.linesRemoved,
    };
  }

  private assertTaskCanBeMerged(task: CoordinatedTask): void {
    if (
      task.landingState === 'landed_pending_review' ||
      task.landingState === 'landed_cleanup_failed' ||
      task.landingState === 'reviewed'
    ) {
      throw new Error(`Task ${task.id} has already landed; review or repair cleanup instead.`);
    }

    const hasManualReviewSignal = task.signalDoneAt !== undefined;
    // landing_escalated unlocks merge_task as an escape hatch for the coordinator.
    // This is not an authority leak: sub-task tokens can only reach land_self (via
    // the /api/tasks/:id/land endpoint); merge_task is a coordinator-only MCP tool,
    // so only a coordinator agent can invoke it here.
    const hasLandingEscalation =
      task.landingState === 'landing_escalated' || task.landingState === 'landing_failed';
    if (task.status === 'running' && !hasManualReviewSignal && !hasLandingEscalation) {
      throw new Error(
        `Task ${task.id} is still running. Use send_prompt for follow-up, or wait until the task signals manual review or reaches a terminal state before calling merge_task.`,
      );
    }
    if (task.status === 'creating') {
      throw new Error(`Task ${task.id} is still starting and cannot be merged yet.`);
    }
  }

  async reviewAndMergeTask(
    taskId: string,
    opts?: { squash?: boolean; message?: string },
  ): Promise<{
    diff: ApiDiffResult;
    merge: { mainBranch: string; linesAdded: number; linesRemoved: number };
  }> {
    const diff = await this.getTaskDiff(taskId);
    const merge = await this.mergeTask(taskId, { ...opts, cleanup: true });
    return { diff, merge };
  }

  async closeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    await this.cleanupTask(taskId);
  }

  /**
   * Remove a coordinated task's backend state when the UI closes it directly.
   * Unlike cleanupTask, this does NOT kill the agent or delete the worktree —
   * the UI has already done both. It only cleans up in-memory coordinator state.
   */
  removeCoordinatedTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    this.suppressPendingNotificationForTask(task);

    this.unsubscribeAgentOutput(task.agentId);
    this.clearAgentBuffers(task.agentId);
    this.resolveIdleWaiters(taskId, 'removed');
    this.unlinkMcpConfigFile(task.mcpConfigPath);

    // For Docker sub-tasks, the UI calls killAgent before removeCoordinatedTask,
    // which stops the sub-task's own container via stopDockerContainer in pty.ts.
    // No additional docker cleanup needed here.

    this.tasks.delete(taskId);
    this.clearPromptDeliveryState(taskId);
    this.controlMap.delete(taskId);
  }

  private async cleanupTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.closingTaskIds.add(taskId);
    this.suppressPendingNotificationForTask(task);

    // Unsubscribe from PTY output
    this.unsubscribeAgentOutput(task.agentId);

    // Kill the agent. For Docker sub-tasks, killAgent also calls docker stop on the
    // sub-task's own container (via stopDockerContainer in pty.ts), which cleanly
    // terminates the entire container rather than just the PTY client process.
    try {
      killAgent(task.agentId);
    } catch {
      /* already dead */
    }

    // Remove worktree. If this fails, keep all coordinator state so the caller
    // can retry. Do NOT emit MCP_TaskClosed — the task still exists on disk.
    try {
      await deleteTask({
        agentIds: [task.agentId],
        branchName: task.branchName,
        deleteBranch: true,
        projectRoot: task.projectRoot,
      });
    } catch (err) {
      console.warn('Failed to delete coordinated task worktree:', err);
      this.clearPromptDeliveryState(taskId);
      this.closingTaskIds.delete(taskId);
      this.notifyRenderer(IPC.MCP_TaskCleanupFailed, {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Clean up internal state — resolve idle and signal waiters before deleting
    // so callers don't hang until their own timeout fires.
    this.resolveIdleWaiters(taskId, 'exited');
    const coordinatorId = task.coordinatorTaskId;
    const anyResolvers = this.anySignalResolvers.get(coordinatorId);
    // Guard against double-resolve: the PTY exit handler (onPtyEvent 'exit') may have
    // already consumed a resolver if the process exited between killAgent and here.
    // reviewNotificationQueued is set by whichever path runs first.
    const firstAnyResolver =
      !task.reviewNotificationQueued && anyResolvers?.length ? anyResolvers.shift() : undefined;
    if (firstAnyResolver) {
      this.suppressPendingNotificationForTask(task);
      task.reviewNotificationQueued = true;
      const remaining = this.countRemaining(coordinatorId);
      // Resolver `complete` from waitForSignalDone handles finishSignalWait.
      firstAnyResolver({
        taskId: task.id,
        name: task.name,
        status: 'exited',
        signalDoneAt: new Date().toISOString(),
        remaining,
      });
    }
    this.clearAgentBuffers(task.agentId);
    // Delete per-task MCP config tmp file
    this.unlinkMcpConfigFile(task.mcpConfigPath);
    this.tasks.delete(taskId);
    this.clearPromptDeliveryState(taskId);
    this.controlMap.delete(taskId);
    this.closingTaskIds.delete(taskId);

    // Notify renderer
    this.notifyRenderer(IPC.MCP_TaskClosed, { taskId });
  }

  getTask(taskId: string): CoordinatedTask | undefined {
    return this.tasks.get(taskId);
  }

  hydrateTask(opts: {
    id: string;
    name: string;
    projectId: string;
    projectRoot: string;
    branchName: string;
    baseBranch?: string;
    worktreePath: string;
    agentId: string;
    coordinatorTaskId: string;
    controlledBy?: 'coordinator' | 'human';
    signalDoneAt?: string;
    signalDoneConsumed?: boolean;
    verification?: SubtaskVerification;
    landingState?: LandingState;
    landingReason?: string;
    landingSummary?: string;
    landedMetadata?: CoordinatedTask['landedMetadata'];
    mcpConfigPath?: string;
    agentCommand?: string;
    preambleFileExistedBefore?: boolean;
    initialPrompt?: string;
    pendingPrompts?: string[];
    assignedPromptDelivered?: boolean;
  }): { mcpLaunchArgs?: string[] } {
    if (!this.coordinators.has(opts.coordinatorTaskId)) {
      throw new Error(`coordinator ${opts.coordinatorTaskId} is not registered`);
    }

    // Validate the persisted mcpConfigPath is exactly one of the two paths that
    // getSubTaskMcpConfigPath generates — basename-only is too permissive and would
    // allow a crafted state file to direct the token write to an arbitrary location.
    // Host mode: os.tmpdir()/parallel-code-subtask-{id}.json
    // Docker mode: dirname(serverPath)/subtask-{id}.json  (looked up from live coordinator state)
    const serverInfo = this.coordinators.get(opts.coordinatorTaskId)?.mcpServerInfo;
    const expectedHostPath = join(os.tmpdir(), `parallel-code-subtask-${opts.id}.json`);
    const expectedDockerPath = serverInfo
      ? join(dirname(serverInfo.serverPath), `subtask-${opts.id}.json`)
      : null;
    const safeMcpConfigPath =
      opts.mcpConfigPath &&
      (opts.mcpConfigPath === expectedHostPath ||
        (expectedDockerPath !== null && opts.mcpConfigPath === expectedDockerPath))
        ? opts.mcpConfigPath
        : undefined;

    const existingTask = this.tasks.get(opts.id);
    if (existingTask) {
      if (safeMcpConfigPath) existingTask.mcpConfigPath = safeMcpConfigPath;
      const mcpLaunchArgs = this.rewriteHydratedSubtaskMcpConfig(
        existingTask,
        opts.coordinatorTaskId,
        safeMcpConfigPath ?? existingTask.mcpConfigPath,
        opts.agentCommand,
      );
      return { mcpLaunchArgs };
    }

    const task: CoordinatedTask = {
      id: opts.id,
      name: opts.name,
      projectId: opts.projectId,
      projectRoot: opts.projectRoot,
      branchName: opts.branchName,
      baseBranch: opts.baseBranch,
      worktreePath: opts.worktreePath,
      agentId: opts.agentId,
      coordinatorTaskId: opts.coordinatorTaskId,
      status: 'exited',
      exitCode: null,
      initialPrompt: opts.initialPrompt,
      pendingPrompts: opts.pendingPrompts?.length ? [...opts.pendingPrompts] : undefined,
      assignedPromptDelivered: opts.assignedPromptDelivered ?? !opts.initialPrompt,
      signalDoneAt: opts.signalDoneAt ? new Date(opts.signalDoneAt) : undefined,
      signalDoneConsumed: opts.signalDoneConsumed,
      verification: opts.verification,
      landingState: opts.landingState,
      landingReason: opts.landingReason,
      landingSummary: opts.landingSummary,
      landedMetadata: opts.landedMetadata,
      preambleFileExistedBefore: opts.preambleFileExistedBefore,
    };
    this.tasks.set(task.id, task);
    if (opts.landedMetadata) {
      const current = this.landedOrderCounters.get(opts.coordinatorTaskId) ?? 0;
      this.landedOrderCounters.set(
        opts.coordinatorTaskId,
        Math.max(current, opts.landedMetadata.landedOrder),
      );
    }
    if (opts.controlledBy === 'human' && (!task.initialPrompt || task.assignedPromptDelivered)) {
      this.controlMap.set(task.id, 'human');
    }

    task.mcpConfigPath = safeMcpConfigPath;

    // Set up output monitoring so wait_for_idle and idle detection work after restart.
    // The agentId matches the one the renderer will use when it respawns the PTY.
    // The token write is inside this try so the cleanup catch removes the task on failure.
    const { agentId } = opts;
    try {
      // If StartMCPServer already ran before this hydration call (the normal restart path),
      // rewrite the config file immediately with the current port/token so the respawned
      // agent gets fresh credentials instead of the stale pre-restart values.
      const mcpLaunchArgs = this.rewriteHydratedSubtaskMcpConfig(
        task,
        opts.coordinatorTaskId,
        safeMcpConfigPath,
        opts.agentCommand,
      );

      this.tailBuffers.set(agentId, '');
      this.decoders.set(agentId, new TextDecoder());
      const outputCb = this.buildAgentOutputCb(task);
      this.subscribers.set(agentId, outputCb);
      // Subscribe immediately if the agent is already spawned (restart scenario where
      // PTY existed before hydration). The spawn handler covers the deferred case.
      try {
        subscribeToAgent(agentId, outputCb);
      } catch {
        /* agent not yet spawned — onPtyEvent('spawn') will subscribe when it starts */
      }
      return { mcpLaunchArgs };
    } catch (err) {
      // Clean up partial map entries so the agentId doesn't linger in state.
      this.clearAgentBuffers(agentId);
      this.subscribers.delete(agentId);
      this.clearPromptDeliveryState(task.id);
      this.tasks.delete(task.id);
      throw err;
    }
  }

  private rewriteHydratedSubtaskMcpConfig(
    task: CoordinatedTask,
    coordinatorTaskId: string,
    mcpConfigPath: string | undefined,
    agentCommand: string | undefined,
  ): string[] | undefined {
    const serverInfo = this.coordinators.get(coordinatorTaskId)?.mcpServerInfo;
    if (!serverInfo) return undefined;
    const { serverUrl, subtaskToken, serverPath } = serverInfo;
    if (!task.doneToken) task.doneToken = randomBytes(24).toString('base64url');
    const mcpConfig = buildSubtaskMcpConfig({
      serverPath,
      serverUrl,
      subtaskToken,
      taskId: task.id,
      doneToken: task.doneToken,
    });
    if (mcpConfigPath) {
      atomicWriteFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
    }
    return buildMcpLaunchArgs(agentCommand ?? 'claude', mcpConfigPath, mcpConfig);
  }

  isRegisteredCoordinator(coordinatorTaskId: string): boolean {
    return this.coordinators.has(coordinatorTaskId);
  }

  registerCoordinator(
    coordinatorTaskId: string,
    projectId: string,
    opts?: { branchName?: string; worktreePath?: string; skipPermissions?: boolean },
  ): void {
    const existing = this.coordinators.get(coordinatorTaskId);
    if (existing) {
      if (opts?.branchName) existing.branchName = opts.branchName;
      if (opts?.worktreePath) existing.worktreePath = opts.worktreePath;
      return;
    }
    // Snapshot the current global project root and defaults so each coordinator gets
    // the values that were active when IT registered, not whatever a later coordinator sets.
    this.coordinators.set(coordinatorTaskId, {
      taskId: coordinatorTaskId,
      lifecycle: 'starting',
      projectId,
      projectRoot: this.projectRoot ?? '',
      branchName: opts?.branchName,
      worktreePath: opts?.worktreePath,
      mcpServerInfo: null,
      spawnDefaults: { ...this.coordinatorSpawnDefaults },
      pendingNotifications: [],
      stagedBatches: new Map(),
      ackedBatchIds: [],
      restageTimer: null,
      propagateSkipPermissions: Boolean(opts?.skipPermissions),
      mcpJsonPath: '',
      createdMcpJson: false,
    });
  }

  setMcpJsonInfo(
    coordinatorTaskId: string,
    mcpJsonPath: string,
    createdMcpJson: boolean,
    previousMcpParallelCode?: unknown,
    writtenMcpParallelCode?: unknown,
  ): void {
    const state = this.coordinators.get(coordinatorTaskId);
    if (state) {
      state.mcpJsonPath = mcpJsonPath;
      state.createdMcpJson = createdMcpJson;
      state.previousMcpParallelCode = previousMcpParallelCode;
      state.writtenMcpParallelCode = writtenMcpParallelCode;
    }
  }

  deregisterCoordinator(coordinatorTaskId: string): void {
    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (!coordinator) return;
    coordinator.lifecycle = 'closing';
    if (coordinator.restageTimer) clearTimeout(coordinator.restageTimer);
    if (coordinator.pendingNotifications.length > 0 || coordinator.stagedBatches.size > 0) {
      logWarn('coordinator.notification', 'staged notification cleared', {
        coordinatorTaskId: coordinator.taskId,
        reason: 'deregister',
        pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
      });
      this.notifyRenderer(IPC.MCP_CoordinatorNotificationCleared, {
        coordinatorTaskId: coordinator.taskId,
      });
    }

    // Clean up coordinator .mcp.json — restore or remove only the parallel-code key.
    // Always read current contents (user may have added keys while running).
    // If there was a pre-existing parallel-code entry, restore it; otherwise delete the key.
    if (coordinator.mcpJsonPath) {
      try {
        const raw = existsSync(coordinator.mcpJsonPath)
          ? readFileSync(coordinator.mcpJsonPath, 'utf-8')
          : null;
        if (raw !== null) {
          const content = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
          if (content.mcpServers) {
            const current = content.mcpServers['parallel-code'];
            const weWrote = coordinator.writtenMcpParallelCode;
            // Only restore/delete if the current value still matches what we wrote,
            // or if we don't have a record of what we wrote (legacy path — always restore).
            const safeToRestore =
              weWrote === undefined || JSON.stringify(current) === JSON.stringify(weWrote);
            if (safeToRestore) {
              if (coordinator.previousMcpParallelCode !== undefined) {
                content.mcpServers['parallel-code'] = coordinator.previousMcpParallelCode;
              } else {
                delete content.mcpServers['parallel-code'];
              }
            }
          }
          const hasServers = Object.keys(content.mcpServers ?? {}).length > 0;
          const hasOtherKeys = Object.keys(content).filter((k) => k !== 'mcpServers').length > 0;
          if (!hasServers && !hasOtherKeys) {
            unlinkSync(coordinator.mcpJsonPath);
          } else {
            if (!hasServers) delete content.mcpServers;
            atomicWriteFileSync(coordinator.mcpJsonPath, JSON.stringify(content, null, 2));
          }
        }
      } catch {
        /* ignore — file may already be gone or malformed */
      }
    }

    this.coordinators.delete(coordinatorTaskId);
    this.landedOrderCounters.delete(coordinatorTaskId);

    // Resolve any pending wait_for_signal_done calls so they don't hang until
    // the 5-minute timeout fires after the coordinator closes.
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

    // Mark all child tasks belonging to this coordinator as orphaned so that
    // signal_done calls from still-running sub-tasks can still resolve.
    // Do NOT delete the task records — they must remain so signal_done can find them.
    for (const [taskId, task] of this.tasks) {
      if (task.coordinatorTaskId !== coordinatorTaskId) continue;

      // Unsubscribe PTY output callback (stop receiving output, but keep task record)
      this.unsubscribeAgentOutput(task.agentId);
      this.clearAgentBuffers(task.agentId);
      this.clearPromptDeliveryState(taskId);

      // Resolve pending idle waiters so callers aren't left hanging
      this.resolveIdleWaiters(taskId, 'exited');

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
      this.controlMap.set(taskId, 'human');

      this.unlinkMcpConfigFile(task.mcpConfigPath);
      task.mcpConfigPath = undefined;

      // Notify the frontend so it can detach children consistently regardless
      // of whether backend deregistration or renderer close cleanup wins the IPC race.
      this.notifyRenderer(IPC.MCP_TaskStateSync, {
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

  markPromptDelivered(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.clearPromptDeliveryState(taskId);
    task.initialPrompt = undefined;
    task.assignedPromptDelivered = true;
    task.suppressIdleUntil ??= Date.now() + PROMPT_ECHO_IDLE_SUPPRESSION_MS;
    this.tailBuffers.set(task.agentId, '');
    if (task.status !== 'exited' && task.status !== 'error') task.status = 'running';
  }

  rescheduleRestageTimer(coordinatorTaskId: string): void {
    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (!coordinator || coordinator.pendingNotifications.length === 0) return;
    if (this.hasActiveSignalWaiter(coordinatorTaskId)) {
      logWarn('coordinator.notification', 'restage skipped', {
        coordinatorTaskId,
        reason: 'active_signal_wait',
        activeWaitCount: this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0,
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
    }, this.COORDINATOR_RESTAMP_DELAY_MS);
  }

  dropNotification(coordinatorTaskId: string, batchId: string): void {
    const coordinator = this.coordinators.get(coordinatorTaskId);
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
      this.notifyRenderer(IPC.MCP_TaskStateSync, { taskId, needsReview: true });
    }
  }

  ackNotification(coordinatorTaskId: string, batchId: string): void {
    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (!coordinator) return;

    if (coordinator.ackedBatchIds.includes(batchId)) return;

    const pendingIds = coordinator.stagedBatches.get(batchId);
    if (pendingIds) {
      coordinator.pendingNotifications = coordinator.pendingNotifications.filter((n) => {
        if (pendingIds.includes(n.id)) {
          const task = this.tasks.get(n.taskId);
          if (task) task.reviewNotificationQueued = false;
          return false;
        }
        return true;
      });
      coordinator.stagedBatches.delete(batchId);
    }

    coordinator.ackedBatchIds.push(batchId);
    if (coordinator.ackedBatchIds.length > this.MAX_ACKED_BATCH_IDS) {
      coordinator.ackedBatchIds.shift();
    }

    if (coordinator.pendingNotifications.length === 0 && coordinator.restageTimer) {
      clearTimeout(coordinator.restageTimer);
      coordinator.restageTimer = null;
    }
  }

  hasActiveCoordinator(): boolean {
    return this.coordinators.size > 0;
  }

  signalDone(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.assignedPromptDelivered = true;
    task.suppressIdleUntil = undefined;
    task.signalDoneAt = new Date();
    task.signalDoneConsumed = false;

    const coordinatorId = task.coordinatorTaskId;
    const anyResolvers = this.anySignalResolvers.get(coordinatorId);
    const firstAnyResolver = anyResolvers?.length ? anyResolvers.shift() : undefined;
    if (firstAnyResolver) {
      task.signalDoneConsumed = true;
      // Suppress before finishSignalWait so it doesn't re-stage
      this.suppressPendingNotificationForTask(task);
      const remaining = this.countRemaining(coordinatorId);
      // Resolver `complete` from waitForSignalDone handles finishSignalWait.
      firstAnyResolver({
        taskId,
        name: task.name,
        status: task.status,
        signalDoneAt: (task.signalDoneAt ?? new Date()).toISOString(),
        remaining,
      });
      // Tell renderer — coordinator already gets result via MCP return value, no UI notification needed
      this.notifyRenderer(IPC.MCP_TaskStateSync, {
        taskId,
        signalDoneReceived: true,
        signalDoneAt: (task.signalDoneAt ?? new Date()).toISOString(),
        signalDoneConsumed: true,
      });
      logWarn('coordinator.signal_wait', 'wait_for_signal_done finish', {
        taskId,
        coordinatorTaskId: coordinatorId,
        reason: 'signal',
        activeWaitCount: this.activeSignalWaitCounts.get(coordinatorId) ?? 0,
      });
      return true;
    }

    // No active waiter — notify via UI so coordinator sees the completion
    this.notifyRenderer(IPC.MCP_TaskStateSync, {
      taskId,
      signalDoneReceived: true,
      signalDoneAt: (task.signalDoneAt ?? new Date()).toISOString(),
      signalDoneConsumed: false,
    });
    // Don't queue a review notification if the agent hasn't finished spawning yet —
    // renderer state is inconsistent while status is 'creating'.
    // For 'running' and 'idle', the worker explicitly signalled done so treat as idle.
    if (task.status !== 'creating') {
      const state: 'idle' | 'exited' = task.status === 'exited' ? 'exited' : 'idle';
      this.maybeQueueReviewNotification(task, state, task.exitCode ?? null, 5_000);
    }
    return true;
  }

  private queueLandedNotification(task: CoordinatedTask): void {
    const coordinator = this.coordinators.get(task.coordinatorTaskId);
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

  private suppressPendingNotificationForTask(task: CoordinatedTask): void {
    const coordinator = this.coordinators.get(task.coordinatorTaskId);
    if (!coordinator) return;

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
      this.notifyRenderer(IPC.MCP_CoordinatorNotificationCleared, {
        coordinatorTaskId: coordinator.taskId,
      });
    } else {
      // Re-stage with remaining notifications so text is updated
      this.stageBatch(coordinator);
    }
  }

  waitForSignalDone(
    coordinatorTaskId: string,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    requestId?: string,
  ): Promise<WaitForSignalDoneResult> {
    if (!this.coordinators.has(coordinatorTaskId)) {
      return Promise.reject(new Error(`Coordinator not found: ${coordinatorTaskId}`));
    }
    // Replay the cached result if this requestId already delivered — handles retry
    // after the HTTP response was lost before the client received it.
    // Key includes coordinatorTaskId to prevent cross-coordinator replay.
    if (requestId) {
      const cached = this.recentlyDelivered.get(coordinatorTaskId, requestId);
      if (cached) return Promise.resolve(cached);
    }
    // Return immediately if there's an unconsumed signal
    for (const task of this.tasks.values()) {
      if (
        task.coordinatorTaskId === coordinatorTaskId &&
        task.signalDoneAt &&
        !task.signalDoneConsumed
      ) {
        task.signalDoneConsumed = true;
        // Suppress the staged UI notification that was queued when signalDone ran
        // without an active waiter — otherwise it will auto-fire as a duplicate.
        this.suppressPendingNotificationForTask(task);
        this.notifyRenderer(IPC.MCP_TaskStateSync, {
          taskId: task.id,
          signalDoneConsumed: true,
        });
        const remaining = this.countRemaining(coordinatorTaskId);
        const result = {
          taskId: task.id,
          name: task.name,
          status: task.status,
          signalDoneAt: task.signalDoneAt.toISOString(),
          remaining,
        };
        if (requestId) this.recentlyDelivered.set(coordinatorTaskId, requestId, result);
        return Promise.resolve(result);
      }
    }

    this.beginSignalWait(coordinatorTaskId);
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
      const complete = (result: WaitForSignalDoneResult) => {
        if (settled) return;
        settled = true;
        if (timerRef.value !== undefined) clearTimeout(timerRef.value);
        const resolvers = this.anySignalResolvers.get(coordinatorTaskId);
        if (resolvers) {
          const idx = resolvers.indexOf(complete);
          if (idx >= 0) resolvers.splice(idx, 1);
        }
        this.finishSignalWait(coordinatorTaskId);
        if (requestId) this.recentlyDelivered.set(coordinatorTaskId, requestId, result);
        resolve(result);
      };

      timerRef.value = setTimeout(() => {
        logWarn('coordinator.signal_wait', `wait_for_signal_done timed out after ${timeoutMs}ms`, {
          coordinatorTaskId,
          reason: 'timeout',
          timeoutMs,
          activeWaitCount: this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0,
        });
        const remaining = this.countRemaining(coordinatorTaskId);
        complete({ remaining, timedOut: true });
      }, timeoutMs);

      let resolvers = this.anySignalResolvers.get(coordinatorTaskId);
      if (!resolvers) {
        resolvers = [];
        this.anySignalResolvers.set(coordinatorTaskId, resolvers);
      }
      resolvers.push(complete);
    });
  }

  private countRemaining(coordinatorTaskId: string): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.coordinatorTaskId !== coordinatorTaskId) continue;
      if (task.signalDoneConsumed) continue; // coordinator already processed this one
      if (task.status === 'exited' && !task.signalDoneAt) continue; // exited without signal — handled by UI
      count++;
    }
    return count;
  }

  private beginSignalWait(coordinatorTaskId: string): void {
    this.activeSignalWaitCounts.set(
      coordinatorTaskId,
      (this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0) + 1,
    );
    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (coordinator) {
      this.clearStagedNotificationForCoordinator(coordinator);
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

    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (coordinator && coordinator.pendingNotifications.length > 0) {
      this.stageBatch(coordinator);
    }
  }

  private hasActiveSignalWaiter(coordinatorTaskId: string): boolean {
    return (this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0) > 0;
  }

  private clearStagedNotificationForCoordinator(coordinator: CoordinatorState): void {
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
    this.notifyRenderer(IPC.MCP_CoordinatorNotificationCleared, {
      coordinatorTaskId: coordinator.taskId,
    });
  }

  private pendingNotificationTaskIds(coordinator: CoordinatorState): string[] {
    return coordinator.pendingNotifications.map((n) => n.taskId);
  }

  private notifyRenderer(channel: string, data: unknown): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, data);
    }
  }
}
