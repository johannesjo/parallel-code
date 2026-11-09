// Main-process coordinator for managing sub-agent tasks.
// Manages task lifecycle independently of the SolidJS renderer,
// using existing backend primitives (pty, git, tasks).

import { randomUUID, randomBytes } from 'crypto';
import { unlink as fsUnlink } from 'fs/promises';
import { dirname } from 'path';
import {
  buildSubTaskMcpConfig,
  getSubTaskMcpConfigPath,
  isAllowedSubTaskMcpConfigPath,
  writeSubTaskMcpConfig,
} from './config.js';
import { buildMcpLaunchArgs, isAntigravityCommand } from './agent-args.js';
import { writeAntigravityMcpConfig } from './antigravity-config.js';
import { validateBranchName } from './validation.js';
import {
  detectPreambleFiles,
  filterDiffSections,
  buildNormalizedPreambleFileDiff,
  injectSubTaskPreamble,
  restoreSubTaskPreambleInjection,
  type InjectedSubTaskPreamble,
} from './preamble.js';
import { truncateDiffForTool } from './diff-format.js';
import { execAsync, execStdout, currentBranch, ownDirtyPaths } from './coordinator/git.js';
import {
  buildTaskMcpLaunchArgs,
  refreshChildMcpConfigs,
  restoreCoordinatorMcpJson,
  rewriteSubtaskMcpConfig,
  unlinkMcpConfigFile,
  type SessionMcpProvider,
} from './coordinator/mcp-config.js';
import { CoordinatorNotifications } from './coordinator/notifications.js';
import { CoordinatorLanding, type MergedLines } from './coordinator/landing.js';
import {
  clampWaitTimeoutMs,
  DEFAULT_WAIT_TIMEOUT_MS,
  SignalWaits,
} from './coordinator/signal-waits.js';
import type { Notify } from '../ipc/notify.js';
import { createTask as createBackendTask, deleteTask } from '../ipc/tasks.js';
import { getSkipPermissionsArgs, stripPermissionBypassArgs } from '../shared/skip-permissions.js';
import {
  spawnAgent,
  writeToAgent,
  killAgent,
  subscribeToAgent,
  unsubscribeFromAgent,
  getAgentScrollback,
  getActiveAgentIds,
  getAgentMeta,
  getAgentInputBlocker,
  getAgentPromptSnapshot,
  onPtyEvent,
} from '../ipc/pty.js';
import { onAgentHookEvent } from '../agent-hooks/events.js';
import { getAgentActivityEvidence } from '../agent-hooks/observations.js';
import type { ActivityEvidence, AgentHookEventPayload } from '../agent-hooks/status.js';
import {
  clampCoordinatorConcurrentTasks,
  DEFAULT_COORDINATOR_CONCURRENT_TASKS,
} from '../shared/coordinator-limits.js';
import { getChangedFiles, getAllFileDiffs, getDiffBaseSha, getMainBranch } from '../ipc/git.js';
import {
  stripAnsi,
  cursorRowsToLines,
  chunkContainsAgentPrompt,
  getAgentPromptReadiness,
  AGENT_READY_TAIL_CHARS,
} from '../shared/prompt-detect.js';
import { buildSubTaskPreamble } from './sub-task-preamble.js';
import { isStalled, promptDelivery, type PromptDelivery } from './prompt-delivery.js';
import { verificationRunner } from '../ipc/verify.js';
import { info as logInfo, warn as logWarn } from '../log.js';
import type {
  CoordinatedTask,
  IntegrationPolicy,
  CoordinatorState,
  ApiTaskSummary,
  ApiTaskDetail,
  ApiDiffResult,
  ApiLandSelfResult,
  ArchiveBlocker,
  ArchiveResult,
  LandSelfInput,
  LandingState,
  StalledChild,
  SubtaskVerification,
  WaitForSignalDoneResult,
} from './types.js';
import { IPC } from '../ipc/channels.js';
import { parseCloseSuggestion, type CloseSuggestion } from '../shared/close-suggestion.js';
import {
  parseCompletionRecord,
  type CompletionRecord,
  type SignalDoneResult,
} from '../shared/completion-report.js';

const PROMPT_WRITE_DELAY_MS = 50;
// Enough for the parent to judge the stakes; get_task_diff has the rest.
const ARCHIVE_CHANGED_FILES_MAX = 20;
const INITIAL_PROMPT_READY_DELAY_MS = 1_500;
const MAX_PENDING_PROMPTS = 32;
const MAX_PROMPT_BYTES = 64 * 1024;
const PROMPT_ECHO_IDLE_SUPPRESSION_MS = 2_000;
// A full-screen TUI shows its input prompt mid-turn too: Codex clears it on
// submit before it shows it is working, and keeps it while streaming a reply.
// Its output only stops once the turn ends, so the prompt counts once output
// has settled. Delegation waits as long but only for readiness to persist,
// which a Codex reply streaming under its prompt would pass.
const PROMPT_SETTLE_MS = 1_500;
// Tool hooks of an interrupted turn can still land shortly after the Esc; no
// Stop follows them, so they must not re-arm hook ownership (mirrors the
// renderer's INTERRUPT_SUPPRESS_MS).
const HOOK_INTERRUPT_SUPPRESS_MS = 5_000;
const HOOK_TOOL_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
]);
const FOCUS_IN = '\x1b[I';
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const REST_COORDINATOR_SENTINEL = 'api';

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

export class Coordinator {
  private tasks = new Map<string, CoordinatedTask>();
  private tailBuffers = new Map<string, string>();
  private idleResolvers = new Map<
    string,
    Array<(result: { reason: 'idle' | 'human_control' | 'exited' | 'removed' }) => void>
  >();
  private subscribers = new Map<string, (encoded: string) => void>();
  private decoders = new Map<string, TextDecoder>();
  private controlMap = new Map<string, 'coordinator' | 'human'>();
  private writingPromptTaskIds = new Set<string>();
  private initialPromptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private initialPromptReadyTasks = new Set<string>();
  private promptReadySeenAt = new Map<string, number>();
  private queuedPromptFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Output whose prompt check waits for the screen mirror or for output to settle.
  private deferredPromptChecks = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; echoOnly: boolean }
  >();
  private bracketedPasteAgentIds = new Set<string>();
  private closingTaskIds = new Set<string>();
  private cleanupsInFlight = new Map<string, Promise<void>>();
  private integratingTaskIds = new Set<string>();
  private orchestrationEnabled = true;
  private orchestrationEpoch = 0;

  setOrchestrationEnabled(enabled: boolean): void {
    if (this.orchestrationEnabled === enabled) return;
    this.orchestrationEnabled = enabled;
    if (enabled) return;
    this.orchestrationEpoch += 1;
    for (const parent of this.coordinators.values())
      parent.launchEpoch = (parent.launchEpoch ?? 0) + 1;
    for (const task of this.tasks.values()) this.discardAutomatedPrompts(task);
  }

  private discardAutomatedPrompts(task: CoordinatedTask): void {
    this.clearInitialPromptDeliveryState(task.id);
    this.clearQueuedPromptFlushTimer(task.id);
    task.initialPrompt = undefined;
    task.pendingPrompts = undefined;
    task.promptQueuedAt = undefined;
    task.unsubmittedPrompt = false;
    this.notifyRenderer(IPC.MCP_TaskStateSync, {
      taskId: task.id,
      initialPrompt: null,
      pendingPromptCount: 0,
    });
  }

  private assertOrchestrationEnabled(epoch = this.orchestrationEpoch): void {
    if (!this.orchestrationEnabled || epoch !== this.orchestrationEpoch) {
      throw new Error(
        'Agent orchestration is disabled or this operation was canceled. Enable it in Settings > Agents to start new operations.',
      );
    }
  }

  private sessionMcpProvider?: SessionMcpProvider;

  setSessionMcpProvider(provider: SessionMcpProvider): void {
    this.sessionMcpProvider = provider;
  }
  // Agents that have delivered at least one hook event this session. Hooks own
  // idle/running transitions for these; the output-regex path only feeds
  // prompt-injection readiness. Cleared on PTY exit/respawn (fresh session)
  // and on a user interrupt (no Stop hook follows one).
  private hookLiveAgentIds = new Set<string>();
  // When each agent was last interrupted; see HOOK_INTERRUPT_SUPPRESS_MS.
  private interruptedAt = new Map<string, number>();
  // Sub-task creations past the concurrency check but not yet in this.tasks,
  // so parallel create_task calls can't overshoot the limit.
  private pendingCreateCounts = new Map<string, number>();
  private notify: Notify | null = null;
  private projectRoot: string | null = null;
  private projectId: string | null = null;
  private defaultCoordinatorTaskId: string | null = null;
  private coordinatorSpawnDefaults: { command: string; args: string[] } = {
    command: 'claude',
    args: [],
  };
  private coordinatorAgentEnvFile: string | undefined;
  private coordinators = new Map<string, CoordinatorState>();
  // Serializes concurrent preamble writes to the same file path.
  private preambleWriteQueue = new Map<string, Promise<void>>();
  private notifications: CoordinatorNotifications = new CoordinatorNotifications({
    coordinators: this.coordinators,
    tasks: this.tasks,
    activeSignalWaitCount: (coordinatorTaskId) =>
      this.signalWaits.activeSignalWaitCount(coordinatorTaskId),
    suppressPromptEchoIdleIfNeeded: (task) => this.suppressPromptEchoIdleIfNeeded(task),
    notifyRenderer: (channel, data) => this.notifyRenderer(channel, data),
  });
  private landing = new CoordinatorLanding({
    tasks: this.tasks,
    coordinators: this.coordinators,
    notifications: this.notifications,
    assertOrchestrationEnabled: (epoch) => this.assertOrchestrationEnabled(epoch),
    cleanupLandedTaskResources: (task, merged) => this.cleanupLandedTaskResources(task, merged),
    cleanupTask: (taskId, merged) => this.cleanupTask(taskId, merged),
    notifyRenderer: (channel, data) => this.notifyRenderer(channel, data),
  });
  private signalWaits: SignalWaits = new SignalWaits({
    tasks: this.tasks,
    coordinators: this.coordinators,
    notifications: this.notifications,
    isClosingOrIntegrating: (taskId) =>
      this.closingTaskIds.has(taskId) || this.integratingTaskIds.has(taskId),
    withdrawCloseSuggestion: (task) => this.withdrawCloseSuggestion(task),
    stalledChildren: (coordinatorTaskId) => this.stalledChildren(coordinatorTaskId),
    notifyRenderer: (channel, data) => this.notifyRenderer(channel, data),
  });
  constructor() {
    // Listen for PTY exits to update task status when agents are killed externally
    // (e.g., user closes a child task from the UI).
    // The singleton guard in enableCoordinatorMode (if (coordinator) return) ensures
    // this constructor is called at most once per app lifetime; no teardown needed.
    onPtyEvent('exit', (agentId, data) => {
      this.hookLiveAgentIds.delete(agentId);
      this.interruptedAt.delete(agentId);
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
          // Closing and archiving stop the agent on purpose; neither is a result to report.
          if (this.closingTaskIds.has(task.id) || task.archived) break;
          this.signalWaits.deliverExitToSignalWaiter(task);
          this.notifications.maybeQueueReviewNotification(task, 'exited', exitCode ?? null);
          break;
        }
      }
    });

    // Re-subscribe our output callback when the renderer reattaches to, or explicitly
    // replaces, a managed agent. Without this, our outputCb is lost and we can never
    // detect idle for that sub-task.
    onPtyEvent('spawn', (agentId, data) => {
      const outputCb = this.subscribers.get(agentId);
      if (!outputCb) return; // not a coordinated agent, or initial spawn (not yet subscribed)
      const reattached = (data as { reattached?: boolean } | undefined)?.reattached === true;
      if (!reattached) {
        this.hookLiveAgentIds.delete(agentId);
        this.tailBuffers.set(agentId, '');
      }
      for (const task of this.tasks.values()) {
        if (task.agentId === agentId && task.status === 'exited') {
          task.status = 'running';
          task.exitCode = null;
        }
        if (task.agentId === agentId) {
          if (!reattached) {
            // Only the user restoring the collapsed task respawns an archived child's agent;
            // they want it back, so the parent's waits count it again.
            if (task.archived) {
              task.archived = undefined;
              this.withdrawCloseSuggestion(task);
            }
            // A fresh process has an empty input line.
            task.unsubmittedPrompt = false;
            // Its empty prompt says nothing about prompts the old process took.
            task.promptSubmittedAt = undefined;
            task.promptStartedAt = undefined;
            this.advanceReviewRevision(task);
          }
          this.updateTailFromScrollback(task);
        }
      }
      subscribeToAgent(agentId, outputCb);
    });

    // A bare Esc/Ctrl+C ends the turn without a Stop hook, so hand idle
    // detection back to the ❯-regex path until the next hook event.
    onPtyEvent('interrupt', (agentId) => {
      this.hookLiveAgentIds.delete(agentId);
      this.interruptedAt.set(agentId, Date.now());
    });

    // Hookless native and renderer submissions must also cancel an in-flight
    // report capture. Focus, draft edits and secondary panes do not advance it.
    onPtyEvent('prompt-submitted', (agentId) => {
      const task = this.findTaskByAgentId(agentId);
      if (!task) return;
      // Any Enter, the human's included, submits a body whose own Enter failed.
      task.unsubmittedPrompt = false;
      this.advanceReviewRevision(task);
    });

    // Hook events (Claude Code lifecycle hooks) are the authoritative state
    // channel for agents that emit them; see handleAgentHookEvent.
    onAgentHookEvent((evt) => this.handleAgentHookEvent(evt));
  }

  private findTaskByAgentId(agentId: string): CoordinatedTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.agentId === agentId) return task;
    }
    return undefined;
  }

  /** True for a tool hook that belongs to a turn the user has already interrupted.
   *  Turn boundaries (UserPromptSubmit, SessionStart, Stop) end the window early. */
  private isToolHookOfInterruptedTurn(evt: AgentHookEventPayload): boolean {
    const since = this.interruptedAt.get(evt.agentId);
    if (since === undefined) return false;
    if (!HOOK_TOOL_EVENTS.has(evt.event) || evt.at - since >= HOOK_INTERRUPT_SUPPRESS_MS) {
      this.interruptedAt.delete(evt.agentId);
      return false;
    }
    return true;
  }

  private handleAgentHookEvent(evt: AgentHookEventPayload): void {
    const task = this.findTaskByAgentId(evt.agentId);
    if (!task) return;
    // A hook fired by a session that already exited must not revive its task.
    if (task.status === 'exited' || task.status === 'error') return;
    if (evt.event === 'UserPromptSubmit') this.advanceReviewRevision(task);
    if (this.isToolHookOfInterruptedTurn(evt)) return;
    this.hookLiveAgentIds.add(evt.agentId);
    if (evt.state === 'done') {
      // Stop/StopFailure/SessionStart cannot be prompt echo, so clear (not
      // consume) the echo-suppression window before the shared idle
      // transition. The idle_prompt notification fires ~60 s after the previous
      // turn and can race a prompt sent just now, so it stays subject to it.
      // stableAgentPrompt=false: Stop fires before the TUI repaints its input
      // prompt, so queued prompts go through the delayed, ❯-checked flush.
      if (evt.event !== 'Notification') {
        task.suppressIdleUntil = undefined;
        task.lastPromptEchoText = undefined;
      }
      this.handlePromptDetected(task, false, 'hook');
      return;
    }
    // 'working' and 'waiting' both mean the agent is mid-turn.
    this.markPromptStarted(task);
    this.promptReadySeenAt.delete(task.id);
    if (task.status === 'idle') {
      task.status = 'running';
      this.notifications.suppressPendingNotificationForTask(task);
    }
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
        // Human use may have left the agent mid-turn; wait for a rendered prompt.
        this.scheduleQueuedPromptFlush(task);
      }
    }
  }

  private normalizedTail(agentId: string): string {
    const tail = (this.tailBuffers.get(agentId) ?? '').slice(-AGENT_READY_TAIL_CHARS * 2);
    return (
      stripAnsi(cursorRowsToLines(tail))
        // eslint-disable-next-line no-control-regex -- preserve line breaks for anchored prompt detection.
        .replace(/[\x00-\x09\x0b-\x0c\x0e-\x1f\x7f]/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim()
    );
  }

  /**
   * Whether the agent shows a ready input prompt drawn since the last send, or
   * undefined while that is not known yet. A full-screen TUI such as Codex
   * repaints only changed cells, so a prompt that stays on screen through a
   * turn never reappears in the output stream: read its rendered screen once
   * output has settled. Main-screen agents redraw their input line each turn,
   * so their output tail shows it.
   */
  private freshAgentPrompt(task: CoordinatedTask): boolean | undefined {
    // Sends clear the tail, so until new output arrives the prompt on screen
    // is the one the agent just took.
    if (!this.tailBuffers.get(task.agentId)) return false;
    // The screen parsed so far tells which kind of TUI this is without
    // waiting for the mirror; only its readiness needs the latest output.
    if (getAgentPromptSnapshot(task.agentId, { parsedSoFar: true })?.alternateScreen) {
      const screen = getAgentPromptSnapshot(task.agentId);
      if (!screen) return undefined;
      const readiness = getAgentPromptReadiness(screen.text);
      if (readiness.reason === 'busy') this.markPromptStarted(task);
      if (readiness.ready && Date.now() - (task.lastOutputAt ?? 0) < PROMPT_SETTLE_MS) {
        return undefined;
      }
      return readiness.ready;
    }
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
    const freshPrompt = this.freshAgentPrompt(task);
    // A screen still settling is judged like new output once it has.
    if (freshPrompt === undefined)
      this.deferPromptCheck(task, this.takeDeferredPromptCheck(task.id));
    const hasAgentPrompt = freshPrompt === true;
    if (hasAgentPrompt) {
      this.scheduleInitialPromptDelivery(task, INITIAL_PROMPT_READY_DELAY_MS, true);
      // Replayed scrollback may hold a stale ❯ from a mid-turn frame: hook-live
      // agents go idle on Stop only, and an undelivered assignment is not idle.
      if (!this.awaitingInitialPrompt(task) && !this.hookLiveAgentIds.has(task.agentId)) {
        task.status = 'idle';
        this.notifications.maybeQueueReviewNotification(task, 'idle', null);
      }
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
    if (
      !this.orchestrationEnabled ||
      !this.hasQueuedWork(task) ||
      this.queuedPromptFlushTimers.has(task.id)
    )
      return;
    const timer = setTimeout(() => {
      this.queuedPromptFlushTimers.delete(task.id);
      if (!this.orchestrationEnabled || !this.tasks.has(task.id)) return;
      if (this.controlMap.get(task.id) === 'human') return;
      if (!this.hasQueuedWork(task)) return;
      const ready = this.freshAgentPrompt(task);
      if (!ready) {
        if (ready === undefined) this.scheduleQueuedPromptFlush(task);
        return;
      }
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
    this.takeDeferredPromptCheck(taskId);
    this.promptReadySeenAt.delete(taskId);
    this.writingPromptTaskIds.delete(taskId);
  }

  private scheduleInitialPromptDelivery(
    task: CoordinatedTask,
    delayMs = INITIAL_PROMPT_READY_DELAY_MS,
    promptReady = false,
  ): void {
    if (!this.orchestrationEnabled) return;
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

  private createAgentOutputMonitor(task: CoordinatedTask): (encoded: string) => void {
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
      task.lastOutputAt = Date.now();

      const hasAgentPrompt = this.freshAgentPrompt(task);
      if (
        hasAgentPrompt !== true &&
        task.promptSubmittedAt !== undefined &&
        task.promptStartedAt === undefined &&
        getAgentPromptReadiness(this.normalizedTail(task.agentId)).reason === 'busy'
      ) {
        this.markPromptStarted(task);
      }
      // Earlier output still waiting on the mirror is judged with this chunk.
      const echoOnly = this.takeDeferredPromptCheck(task.id) && this.isPromptEchoOutput(task, text);
      if (hasAgentPrompt === undefined) this.deferPromptCheck(task, echoOnly);
      else this.applyPromptState(task, hasAgentPrompt, echoOnly);
    };
  }

  /** Re-check output the mirror had not parsed yet, or whose prompt has not settled. */
  private deferPromptCheck(task: CoordinatedTask, echoOnly: boolean): void {
    const timer = setTimeout(() => {
      this.deferredPromptChecks.delete(task.id);
      // An empty tail means a send cleared it since: this output is stale.
      if (!this.tasks.has(task.id) || !this.tailBuffers.get(task.agentId)) return;
      const hasAgentPrompt = this.freshAgentPrompt(task);
      if (hasAgentPrompt === undefined) this.deferPromptCheck(task, echoOnly);
      else this.applyPromptState(task, hasAgentPrompt, echoOnly);
    }, PROMPT_WRITE_DELAY_MS);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.deferredPromptChecks.set(task.id, { timer, echoOnly });
  }

  /** Cancel a deferred prompt check; true unless the output it held was more than echo. */
  private takeDeferredPromptCheck(taskId: string): boolean {
    const deferred = this.deferredPromptChecks.get(taskId);
    if (!deferred) return true;
    clearTimeout(deferred.timer);
    this.deferredPromptChecks.delete(taskId);
    return deferred.echoOnly;
  }

  private applyPromptState(
    task: CoordinatedTask,
    hasAgentPrompt: boolean,
    echoOnly: boolean,
  ): void {
    const stableAgentPrompt = this.markAgentPromptReady(task, hasAgentPrompt);
    // A rendered prompt only counts once output settled, so like a hook Stop
    // it cannot be prompt echo: clear the echo window instead of consuming it.
    const settledScreenPrompt =
      hasAgentPrompt &&
      getAgentPromptSnapshot(task.agentId, { parsedSoFar: true })?.alternateScreen === true;
    if ((!hasAgentPrompt && task.assignedPromptDelivered && !echoOnly) || settledScreenPrompt) {
      task.suppressIdleUntil = undefined;
      task.lastPromptEchoText = undefined;
    }
    if (hasAgentPrompt) {
      this.handlePromptDetected(task, stableAgentPrompt);
    } else if (task.status === 'idle' && !this.hookLiveAgentIds.has(task.agentId)) {
      // Hook-live agents flip back to running only on hook evidence — TUI
      // repaints and status-line noise must not override a hook-reported idle.
      task.status = 'running';
      this.notifications.suppressPendingNotificationForTask(task);
    }
  }

  private handlePromptDetected(
    task: CoordinatedTask,
    stableAgentPrompt: boolean,
    source: 'regex' | 'hook' = 'regex',
  ): void {
    // Only a rendered ❯ proves the agent can take input: a hook `done` fires
    // before the TUI repaints, and marking the initial prompt ready on it would
    // skip the startup blockers (MCP boot, trust dialog) readiness checks for.
    this.scheduleInitialPromptDelivery(task, INITIAL_PROMPT_READY_DELAY_MS, source === 'regex');
    if (
      !task.initialPrompt &&
      !this.awaitingInitialPrompt(task) &&
      this.controlMap.get(task.id) !== 'human' &&
      this.hasQueuedWork(task)
    ) {
      if (stableAgentPrompt && !this.writingPromptTaskIds.has(task.id)) {
        void this.flushNextQueuedPrompt(task);
      } else {
        this.scheduleQueuedPromptFlush(task);
      }
      return;
    }
    // Once hooks report state for this agent, only hook Stop events may drive
    // the idle transition — the ❯-regex above still schedules prompt delivery
    // but must not race a mid-turn TUI frame into a false idle.
    if (source === 'regex' && this.hookLiveAgentIds.has(task.agentId)) {
      return;
    }
    // Before the assignment is delivered this ❯ (or startup hook) is just the
    // empty startup prompt; reporting idle would resolve wait_for_idle early.
    if (this.awaitingInitialPrompt(task)) return;
    // A typed but unsubmitted body is not a finished turn, even under human control.
    if (task.unsubmittedPrompt) return;
    if (task.suppressIdleUntil !== undefined && this.suppressPromptEchoIdleIfNeeded(task)) {
      return;
    }
    if (task.status === 'running') {
      task.status = 'idle';
      this.notifications.maybeQueueReviewNotification(task, 'idle', null);
    }
    const resolvers = this.idleResolvers.get(task.id);
    if (resolvers?.length) {
      for (const resolve of resolvers) resolve({ reason: 'idle' });
      this.idleResolvers.delete(task.id);
    }
  }

  private async tryDeliverInitialPrompt(taskId: string): Promise<void> {
    if (!this.orchestrationEnabled) return;
    const epoch = this.orchestrationEpoch;
    const task = this.tasks.get(taskId);
    if (!task?.initialPrompt || task.assignedPromptDelivered) return;
    if (task.status === 'exited' || task.status === 'error') return;

    const readiness = getAgentPromptReadiness(this.normalizedTail(task.agentId));
    // The sticky ready flag only covers a blank tail; a trust dialog, MCP boot or
    // busy marker that appeared since must still block delivery.
    const blocked = readiness.reason === 'startup_or_dialog' || readiness.reason === 'busy';
    const promptReady = !blocked && (this.initialPromptReadyTasks.has(taskId) || readiness.ready);
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
        // The body is in the agent's input, so the assignment counts as handed over;
        // leaving it undelivered would strand prompts queued behind it. Not
        // markPromptDelivered: the agent has not started work.
        task.assignedPromptDelivered = true;
        this.notifyRenderer(IPC.MCP_TaskStateSync, {
          taskId: task.id,
          initialPrompt: null,
        });
        return;
      }
      if (
        this.orchestrationEnabled &&
        epoch === this.orchestrationEpoch &&
        this.tasks.has(task.id)
      ) {
        task.initialPrompt = prompt;
        this.scheduleInitialPromptDelivery(task, INITIAL_PROMPT_READY_DELAY_MS, promptReady);
      }
    } finally {
      this.writingPromptTaskIds.delete(task.id);
    }
  }

  setNotify(notify: Notify): void {
    this.notify = notify;
  }

  setNotificationDelayMs(ms: number): void {
    this.notifications.setNotificationDelayMs(ms);
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
    refreshChildMcpConfigs(
      this.tasks.values(),
      coordinatorTaskId,
      { serverUrl, subtaskToken, serverPath },
      state?.dockerContainerName ?? null,
      this.sessionMcpProvider,
    );
  }

  setCoordinatorSpawnDefaults(coordinatorTaskId: string, command: string, args: string[]): void {
    const state = this.coordinators.get(coordinatorTaskId);
    if (state) {
      state.spawnDefaults = { command, args };
    }
    // Also update global fallback.
    this.coordinatorSpawnDefaults = { command, args };
  }

  /** Sub-tasks run the same agent CLI as the coordinator, so they need the same
   *  env file — otherwise they spawn without the credentials it supplies. */
  setCoordinatorAgentEnvFile(coordinatorTaskId: string, envFile: string | undefined): void {
    const state = this.coordinators.get(coordinatorTaskId);
    if (state) state.agentEnvFile = envFile;
    this.coordinatorAgentEnvFile = envFile;
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

  async createTask(opts: {
    name: string;
    prompt?: string;
    coordinatorTaskId: string;
    projectId?: string;
    projectRoot?: string;
    agentCommand?: string;
    agentArgs?: string[];
    agentEnvFile?: string;
    skipPermissions?: boolean;
    baseBranch?: string;
    snapshotCommit?: string;
    integrationPolicy?: IntegrationPolicy;
    launchGuard?: () => void | Promise<void>;
    nativeLaunchGuard?: () => void;
  }): Promise<CoordinatedTask> {
    const isAgentCreation = opts.coordinatorTaskId !== REST_COORDINATOR_SENTINEL;
    if (isAgentCreation) this.assertOrchestrationEnabled();
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

    const epoch = coordinatorState.launchEpoch ?? 0;
    const assertNativeLaunch = () => {
      if (isAgentCreation) this.assertOrchestrationEnabled();
      this.assertParentAdmission(coordinatorId, epoch);
      opts.nativeLaunchGuard?.();
      this.assertParentAdmission(coordinatorId, epoch);
    };
    const assertLaunch = async () => {
      if (isAgentCreation) this.assertOrchestrationEnabled();
      this.assertParentAdmission(coordinatorId, epoch);
      await opts.launchGuard?.();
      this.assertParentAdmission(coordinatorId, epoch);
    };
    await assertLaunch();

    // Hard concurrency gate — the preamble instructs the model to stay under
    // the limit, but instructions drift; this enforces it.
    const maxConcurrent = clampCoordinatorConcurrentTasks(
      coordinatorState.maxConcurrentSubTasks ?? DEFAULT_COORDINATOR_CONCURRENT_TASKS,
    );
    const inFlight =
      this.countInFlightSubTasks(coordinatorId) +
      (this.pendingCreateCounts.get(coordinatorId) ?? 0);
    if (inFlight >= maxConcurrent) {
      throw new Error(
        `Sub-task concurrency limit reached (${inFlight}/${maxConcurrent} in flight). ` +
          'Use wait_for_signal_done, then review and merge or close finished sub-tasks before creating more.',
      );
    }
    this.pendingCreateCounts.set(
      coordinatorId,
      (this.pendingCreateCounts.get(coordinatorId) ?? 0) + 1,
    );
    // The reservation is released as soon as the task is in this.tasks (where
    // countInFlightSubTasks sees it) — holding it longer would count the task
    // twice while its worktree/agent spawn finishes.
    let reserved = true;
    const releaseReservation = () => {
      if (!reserved) return;
      reserved = false;
      const pending = (this.pendingCreateCounts.get(coordinatorId) ?? 1) - 1;
      if (pending <= 0) this.pendingCreateCounts.delete(coordinatorId);
      else this.pendingCreateCounts.set(coordinatorId, pending);
    };
    try {
      return await this.createTaskUnchecked(opts, {
        coordinatorId,
        coordinatorState,
        onInserted: releaseReservation,
        assertLaunch,
        assertNativeLaunch,
      });
    } finally {
      releaseReservation();
    }
  }

  private assertParentAdmission(parentId: string, epoch?: number): CoordinatorState {
    const parent = this.coordinators.get(parentId);
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

  stopChildren(parentId: string): void {
    const parent = this.coordinators.get(parentId);
    if (!parent) throw new Error('Parent task not registered.');
    parent.paused = true;
    parent.launchEpoch = (parent.launchEpoch ?? 0) + 1;
    for (const task of this.tasks.values()) {
      if (task.coordinatorTaskId !== parentId) continue;
      this.clearPromptDeliveryState(task.id);
      task.pendingPrompts = undefined;
      task.promptQueuedAt = undefined;
      this.controlMap.set(task.id, 'human');
      for (const agentId of this.agentIdsForTask(task)) killAgent(agentId);
    }
  }

  resumeChildren(parentId: string): void {
    const parent = this.coordinators.get(parentId);
    if (!parent || parent.lifecycle === 'closing' || parent.lifecycle === 'closed') {
      throw new Error('Parent task unavailable.');
    }
    parent.paused = false;
  }

  /** Reserve before a restored/stopped child is spawned; release in the caller's finally. */
  reserveChildRestart(taskId: string): (() => void) & { assertAllowed: () => void } {
    const task = this.tasks.get(taskId);
    if (!task) return Object.assign(() => {}, { assertAllowed: () => {} });
    const parent = this.assertParentAdmission(task.coordinatorTaskId);
    const epoch = parent.launchEpoch ?? 0;
    const assertAllowed = () => {
      this.assertParentAdmission(task.coordinatorTaskId, epoch);
      if (
        this.tasks.get(taskId) !== task ||
        this.integratingTaskIds.has(taskId) ||
        this.closingTaskIds.has(taskId)
      ) {
        throw new Error('Child restart was canceled or integration is in progress.');
      }
    };
    if (this.integratingTaskIds.has(taskId)) throw new Error('Task integration is in progress.');
    // Replacing an existing PTY does not consume an additional task slot.
    if (this.isChildInFlight(task)) return Object.assign(() => {}, { assertAllowed });
    const parentId = task.coordinatorTaskId;
    const pending = this.pendingCreateCounts.get(parentId) ?? 0;
    const limit = clampCoordinatorConcurrentTasks(
      parent.maxConcurrentSubTasks ?? DEFAULT_COORDINATOR_CONCURRENT_TASKS,
    );
    if (this.countInFlightSubTasks(parentId) + pending >= limit)
      throw new Error('Child concurrency limit reached.');
    this.pendingCreateCounts.set(parentId, pending + 1);
    let released = false;
    return Object.assign(
      () => {
        if (released) return;
        released = true;
        const remaining = (this.pendingCreateCounts.get(parentId) ?? 1) - 1;
        if (remaining > 0) this.pendingCreateCounts.set(parentId, remaining);
        else this.pendingCreateCounts.delete(parentId);
      },
      { assertAllowed },
    );
  }

  /** Detach first; the caller persists these IDs before removing the parent's worktree. */
  detachChildren(parentId: string): string[] {
    const children = [...this.tasks.values()].filter((task) => task.coordinatorTaskId === parentId);
    if (
      (this.pendingCreateCounts.get(parentId) ?? 0) > 0 ||
      children.some((task) => task.status === 'creating')
    ) {
      throw new Error(
        'A child launch is still settling. Retry closing after it finishes or is canceled.',
      );
    }
    if (children.some((task) => this.integratingTaskIds.has(task.id))) {
      throw new Error(
        'A child is being integrated. Wait for integration before closing the parent.',
      );
    }
    const parent = this.coordinators.get(parentId);
    if (parent) {
      parent.lifecycle = 'closing';
      parent.paused = true;
      parent.launchEpoch = (parent.launchEpoch ?? 0) + 1;
    }
    this.deregisterCoordinator(parentId);
    for (const task of children) this.removeCoordinatedTask(task.id);
    return children.map((task) => task.id);
  }

  /** Detach one child while its parent keeps running. Returns the former parent's id, if any. */
  detachChild(childId: string): string | undefined {
    const task = this.tasks.get(childId);
    if (!task) return undefined;
    if (task.status === 'creating')
      throw new Error('The child is still starting. Retry detaching after it finishes.');
    if (this.integratingTaskIds.has(childId))
      throw new Error('The child is being integrated. Wait for integration before detaching.');
    this.removeCoordinatedTask(childId);
    return task.coordinatorTaskId;
  }

  private isChildInFlight(task: CoordinatedTask): boolean {
    return (
      (task.status !== 'exited' && task.status !== 'error') ||
      getActiveAgentIds().some((agentId) => getAgentMeta(agentId)?.taskId === task.id)
    );
  }

  private countInFlightSubTasks(coordinatorId: string): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.coordinatorTaskId !== coordinatorId) continue;
      if (!this.isChildInFlight(task)) continue;
      count++;
    }
    return count;
  }

  private async createTaskUnchecked(
    opts: {
      name: string;
      prompt?: string;
      projectId?: string;
      projectRoot?: string;
      agentCommand?: string;
      agentArgs?: string[];
      agentEnvFile?: string;
      skipPermissions?: boolean;
      baseBranch?: string;
      snapshotCommit?: string;
      integrationPolicy?: IntegrationPolicy;
    },
    ctx: {
      coordinatorId: string;
      coordinatorState: CoordinatorState;
      /** Called once the task is registered in this.tasks. */
      onInserted: () => void;
      assertLaunch: () => Promise<void>;
      assertNativeLaunch: () => void;
    },
  ): Promise<CoordinatedTask> {
    const { coordinatorId, coordinatorState, onInserted, assertLaunch, assertNativeLaunch } = ctx;
    // Checked first so a missing notifier cannot strand a worktree or a 'creating' task.
    const notify = this.notify;
    if (!notify) throw new Error('No notifier set on coordinator');
    const root = opts.projectRoot ?? coordinatorState.projectRoot ?? this.projectRoot;
    const projId = opts.projectId ?? coordinatorState.projectId ?? this.projectId;
    if (!root || !projId) throw new Error('No project configured for coordinator');
    // Children land on main unless the caller deliberately targets another
    // branch, so results do not pile up on the coordinator's branch.
    const baseBranch = opts.baseBranch ?? (await getMainBranch(root));
    validateBranchName(baseBranch, 'baseBranch');

    if (opts.snapshotCommit && !/^[a-f0-9]{40,64}$/i.test(opts.snapshotCommit)) {
      throw new Error('Invalid snapshot commit.');
    }
    if (opts.snapshotCommit) {
      if (!coordinatorState.worktreePath || !baseBranch)
        throw new Error('The parent snapshot is unavailable.');
      const [head, branch] = await Promise.all([
        execAsync('git', ['rev-parse', 'HEAD'], { cwd: coordinatorState.worktreePath }),
        currentBranch(coordinatorState.worktreePath),
      ]);
      if (execStdout(head).trim() !== opts.snapshotCommit || branch !== baseBranch) {
        throw new Error('The parent branch or commit changed. Refresh the assignment snapshot.');
      }
    }
    await assertLaunch();
    // Keep the integration branch separate from the immutable creation snapshot.
    // Create worktree + branch via existing backend
    const result = await createBackendTask(
      opts.name,
      root,
      ['.claude', 'node_modules'],
      'task',
      baseBranch,
      ...(opts.snapshotCommit ? [opts.snapshotCommit] : []),
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
      integrationPolicy: opts.integrationPolicy ?? 'automatic',
      worktreePath: result.worktree_path,
      agentId,
      coordinatorTaskId: coordinatorId,
      status: 'creating',
      exitCode: null,
      initialPrompt: opts.prompt
        ? buildSubTaskPreamble(coordinatorState.verifyCommand, opts.integrationPolicy) + opts.prompt
        : undefined,
      promptQueuedAt: opts.prompt ? Date.now() : undefined,
      dockerContainerName: this.coordinators.get(coordinatorId)?.dockerContainerName ?? null,
    };

    this.tasks.set(task.id, task);
    if (!this.orchestrationEnabled) this.discardAutomatedPrompts(task);
    onInserted();
    this.tailBuffers.set(agentId, '');

    // Subscribe to PTY output for prompt detection
    const decoder = new TextDecoder();
    this.decoders.set(agentId, decoder);

    const outputCb = this.createAgentOutputMonitor(task);
    this.subscribers.set(agentId, outputCb);

    // closeTask/removeCoordinatedTask can delete the task while we are awaiting;
    // continuing would spawn into a deleted worktree and announce a dead task.
    const assertStillPresent = () => {
      if (this.tasks.get(task.id) !== task || this.closingTaskIds.has(task.id)) {
        throw new Error(`Task ${task.id} was closed during creation`);
      }
    };

    const agentCommand = opts.agentCommand ?? coordinatorState.spawnDefaults.command;
    const dockerContainerName =
      this.coordinators.get(task.coordinatorTaskId)?.dockerContainerName ?? null;

    let preambleInjection: InjectedSubTaskPreamble | undefined;
    let subTaskMcpConfigPath: string | undefined;
    try {
      preambleInjection = await injectSubTaskPreamble({
        worktreePath: result.worktree_path,
        agentCommand,
        queue: this.preambleWriteQueue,
        integrationPolicy: task.integrationPolicy,
      });
      task.preambleFileExistedBefore = preambleInjection.existedBefore;
      assertStillPresent();

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
        const session = this.sessionMcpProvider?.(task);
        const mcpConfig = buildSubTaskMcpConfig({
          serverPath,
          serverUrl,
          subtaskToken: session?.token ?? subtaskToken,
          sessionCapabilities: session?.sessionCapabilities,
          taskId: task.id,
          doneToken,
        });
        subTaskMcpConfig = mcpConfig;
        const configPath = getSubTaskMcpConfigPath(dockerContainerName, serverPath, task.id);
        await writeSubTaskMcpConfig(configPath, mcpConfig);
        subTaskMcpConfigPath = configPath;
        task.mcpConfigPath = configPath;
        // After recording the temp path, so a failure here still cleans up its token.
        if (isAntigravityCommand(agentCommand)) {
          writeAntigravityMcpConfig(result.worktree_path, mcpConfig);
          task.antigravityWorkspaceMcp = true;
        }
        assertStillPresent();
      }

      const skipPermissions = opts.skipPermissions ?? coordinatorState.propagateSkipPermissions;
      const inheritedArgs = opts.agentArgs ?? coordinatorState.spawnDefaults.args;
      // Custom agent args may carry their own bypass flags; without propagation
      // the child must not inherit them.
      const agentArgs = skipPermissions
        ? inheritedArgs
        : stripPermissionBypassArgs(agentCommand, inheritedArgs);
      // Some CLIs (clap) reject a repeated flag, so add only what is missing.
      const bypassArgs = skipPermissions ? getSkipPermissionsArgs(agentCommand) : [];
      const baseArgs = [...agentArgs, ...bypassArgs.filter((arg) => !agentArgs.includes(arg))];
      const mcpArgs = subTaskMcpConfig
        ? buildTaskMcpLaunchArgs(agentCommand, subTaskMcpConfigPath, subTaskMcpConfig)
        : [];
      const agentFinalArgs = [...baseArgs, ...mcpArgs];

      // In Docker coordinator mode, each sub-task gets its own `docker run` container
      // so HOME directories are isolated and cleanup is clean (`docker stop` on the
      // sub-task container, rather than killing processes inside the coordinator).
      const channelId = randomUUID();

      await assertLaunch();
      assertStillPresent();
      await spawnAgent(
        notify,
        {
          taskId: task.id,
          agentId,
          command: agentCommand,
          args: agentFinalArgs,
          cwd: result.worktree_path,
          env: {},
          envFile: opts.agentEnvFile ?? coordinatorState.agentEnvFile,
          projectId: projId,
          cols: 120,
          rows: 40,
          ...(dockerContainerName
            ? {
                dockerMode: true,
                dockerImage: coordinatorState.dockerImage ?? undefined,
                // resolveWorktreeGitDirMount adds the main .git dir mount.
                dockerMountWorktreeParent: true,
                // The coordinator's .parallel-code/ holds the MCP server and this
                // sub-task's config; its worktree need not share the child's parent.
                dockerReadOnlyMounts: this.getDockerMcpMounts(task.id),
              }
            : {}),
          onOutput: { __CHANNEL_ID__: channelId },
        },
        assertNativeLaunch,
      );

      try {
        assertStillPresent();
      } catch (err) {
        // Closed while spawning: the close already killed any earlier PTY, so this
        // late one is ours to stop.
        this.killAgentBestEffort(agentId);
        throw err;
      }

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
        integrationPolicy: task.integrationPolicy,
        completion: task.completion,
        reviewRevision: task.reviewRevision,
        signalDoneReceived: task.signalDoneAt !== undefined,
        signalDoneAt: task.signalDoneAt?.toISOString(),
        signalDoneConsumed: task.signalDoneConsumed ?? false,
        baseBranch: task.baseBranch,
        mcpConfigPath: subTaskMcpConfigPath,
        prompt: task.initialPrompt,
        preambleFileExistedBefore: task.preambleFileExistedBefore,
        agentCommand: agentCommand,
        agentArgs: notifyAgentArgs,
        mcpLaunchArgs: mcpArgs,
        skipPermissions: opts.skipPermissions ?? coordinatorState.propagateSkipPermissions,
      });

      return task;
    } catch (err) {
      // Restore injected preamble file before cleaning up the worktree.
      // Must await — fire-and-forget could race with cleanupTask removing the worktree.
      await restoreSubTaskPreambleInjection(preambleInjection);
      // Best-effort cleanup: kill agent, remove worktree/branch, clear in-memory state.
      // cleanupTask handles all of this; the task is still in this.tasks so it can find it.
      // Also delete the MCP config if it was written but not yet stored on task.mcpConfigPath.
      if (subTaskMcpConfigPath && !task.mcpConfigPath) {
        fsUnlink(subTaskMcpConfigPath).catch(() => {});
      }
      // If cleanup fails the task stays in this.tasks; as 'error' it no longer
      // occupies a concurrency slot and hook events cannot revive it.
      task.status = 'error';
      this.cleanupTask(task.id).catch((cleanupErr) => {
        logWarn('coordinator.create_task', 'cleanup after failed creation failed', {
          taskId: task.id,
          err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      });
      throw err;
    }
  }

  private killAgentBestEffort(agentId: string): void {
    try {
      killAgent(agentId);
    } catch (err) {
      logWarn('coordinator.kill_agent', 'kill failed (agent may already be gone)', {
        agentId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private activityEvidence(task: CoordinatedTask): ActivityEvidence {
    return (
      getAgentActivityEvidence(task.agentId) ?? {
        agentId: task.agentId,
        source: 'process',
        activity: 'unknown',
        event:
          task.status === 'exited' || task.status === 'error'
            ? 'ProcessUnavailable'
            : 'NoObservation',
        freshness: 'unknown',
      }
    );
  }

  listTasks(): ApiTaskSummary[] {
    return Array.from(this.tasks.values()).map((t) => ({
      id: t.id,
      name: t.name,
      branchName: t.branchName,
      status: t.status,
      activityEvidence: this.activityEvidence(t),
      delivery: this.promptDelivery(t),
      coordinatorTaskId: t.coordinatorTaskId,
      integrationPolicy: t.integrationPolicy,
      signalDoneAt: t.signalDoneAt?.toISOString(),
      closeSuggestion: t.closeSuggestion,
      archived: t.archived,
      completion: t.completion,
      reviewRevision: t.reviewRevision,
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
      integrationPolicy: task.integrationPolicy,
      exitCode: task.exitCode,
      activityEvidence: this.activityEvidence(task),
      delivery: this.promptDelivery(task),
      pendingPrompt: task.pendingPrompts?.[0],
      pendingPrompts: task.pendingPrompts ? [...task.pendingPrompts] : undefined,
      pendingPromptCount: task.pendingPrompts?.length,
      signalDoneAt: task.signalDoneAt?.toISOString(),
      closeSuggestion: task.closeSuggestion,
      archived: task.archived,
      completion: task.completion,
      reviewRevision: task.reviewRevision,
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
    this.assertOrchestrationEnabled();
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    // Its agent is stopped and only the user can restore it; a queued prompt would never land.
    if (task.archived)
      throw new Error('Task is archived. Ask the user to restore it, or create a new task.');
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES)
      throw new Error(`Prompt exceeds ${MAX_PROMPT_BYTES} byte limit`);
    const queueLen = task.pendingPrompts?.length ?? 0;
    if (queueLen >= MAX_PENDING_PROMPTS)
      throw new Error(`Prompt queue full (${MAX_PENDING_PROMPTS} pending)`);
    this.advanceReviewRevision(task);
    // New work means the coordinator wants this child after all, even while it queues.
    this.withdrawCloseSuggestion(task);
    if (task.initialPrompt && !task.assignedPromptDelivered) {
      this.queuePrompt(task, prompt);
      this.clearInitialPromptTimer(task.id);
      this.scheduleInitialPromptDelivery(task, 0);
      return { queued: true };
    }
    if (
      task.pendingPrompts?.length ||
      this.controlMap.get(taskId) === 'human' ||
      this.writingPromptTaskIds.has(taskId)
    ) {
      this.queuePrompt(task, prompt);
      return { queued: true };
    }

    // Acquire write lock synchronously before the first await so a concurrent
    // sendPrompt call sees the lock and queues rather than writing through.
    this.writingPromptTaskIds.add(task.id);
    try {
      await this.writePromptToTask(task, prompt);
    } finally {
      this.writingPromptTaskIds.delete(task.id);
      // The write cleared the tail, so this waits for the next rendered prompt
      // instead of typing a queued prompt into a busy agent.
      this.scheduleQueuedPromptFlush(task);
    }
    return { queued: false };
  }

  private queuePrompt(task: CoordinatedTask, prompt: string): void {
    task.pendingPrompts = [...(task.pendingPrompts ?? []), prompt];
    task.promptQueuedAt ??= Date.now();
  }

  private markPromptSubmitted(task: CoordinatedTask): void {
    task.promptSubmittedAt = Date.now();
    task.promptStartedAt = undefined;
    task.promptQueuedAt = task.pendingPrompts?.length ? Date.now() : undefined;
  }

  /** Only a prompt the coordinator submitted awaits confirmation. */
  private markPromptStarted(task: CoordinatedTask): void {
    if (task.promptSubmittedAt !== undefined) task.promptStartedAt ??= Date.now();
  }

  private promptDelivery(task: CoordinatedTask): PromptDelivery | undefined {
    if (task.status === 'exited' || task.status === 'error') return undefined;
    const now = Date.now();
    const blockedBy =
      this.controlMap.get(task.id) === 'human'
        ? 'user_activity'
        : this.awaitingInitialPrompt(task)
          ? 'agent_startup'
          : 'agent_busy';
    return promptDelivery({
      now,
      queuedAt: this.hasUndeliveredPrompt(task) ? (task.promptQueuedAt ?? now) : undefined,
      blockedBy,
      submittedAt: task.promptSubmittedAt,
      startedAt: task.promptStartedAt,
      // No output at all since the submit is as telling as a repainted empty prompt.
      awaitingInput:
        this.normalizedTail(task.agentId) === '' || this.freshAgentPrompt(task) === true,
    });
  }

  private stalledChildren(coordinatorTaskId: string): StalledChild[] {
    const stalled: StalledChild[] = [];
    for (const task of this.tasks.values()) {
      // A child that signalled done took its prompt, whatever its screen shows.
      if (task.coordinatorTaskId !== coordinatorTaskId || task.signalDoneAt) continue;
      // The parent already gave this child up; reporting it again would only nag the user.
      if (task.closeSuggestion) continue;
      const delivery = this.promptDelivery(task);
      if (delivery && isStalled(delivery, task.status === 'idle')) {
        stalled.push({ taskId: task.id, name: task.name, delivery });
      }
    }
    return stalled;
  }

  /** A body whose Enter failed is still in the agent's input. Submit it instead of
   *  typing the next prompt onto it; the queue flushes on the following ready prompt. */
  private submitStrandedPrompt(task: CoordinatedTask, epoch: number): void {
    try {
      this.assertOrchestrationEnabled(epoch);
      writeToAgent(task.agentId, '\r');
    } catch (err) {
      logWarn('coordinator.prompt_queue', 'Enter retry for an unsubmitted prompt failed', {
        taskId: task.id,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    task.unsubmittedPrompt = false;
    this.markPromptSubmitted(task);
    task.status = 'running';
    // The ❯ that triggered this is stale; wait for a fresh one before the next prompt.
    this.tailBuffers.set(task.agentId, '');
    this.promptReadySeenAt.delete(task.id);
    this.scheduleQueuedPromptFlush(task);
  }

  private async flushNextQueuedPrompt(task: CoordinatedTask): Promise<void> {
    if (!this.orchestrationEnabled) return;
    const epoch = this.orchestrationEpoch;
    if (this.controlMap.get(task.id) === 'human') return;
    if (task.initialPrompt && !task.assignedPromptDelivered) return;
    if (this.writingPromptTaskIds.has(task.id)) return;
    if (task.unsubmittedPrompt) {
      this.submitStrandedPrompt(task, epoch);
      return;
    }
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
      } else if (this.orchestrationEnabled && epoch === this.orchestrationEpoch) {
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
    this.assertOrchestrationEnabled();
    const epoch = this.orchestrationEpoch;
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
        this.assertOrchestrationEnabled(epoch);
      } catch (err) {
        // Cancelled, not stranded: disabling orchestration discarded this prompt.
        throw new PromptWriteError('Prompt Enter write failed', 'enter', err);
      }
      try {
        writeToAgent(task.agentId, '\r');
      } catch (err) {
        task.unsubmittedPrompt = true;
        throw new PromptWriteError('Prompt Enter write failed', 'enter', err);
      }
      logInfo('coordinator.prompt_write', 'enter_written', {
        taskId: task.id,
        agentId: task.agentId,
        delayMs: submitDelayMs,
      });
      // A direct write's Enter also submits any body stranded before it.
      task.unsubmittedPrompt = false;
      this.markPromptSubmitted(task);
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

  hasPendingPrompt(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    return !!(task?.initialPrompt || task?.pendingPrompts?.length || task?.automationWriteInFlight);
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
    return this.waitForIdleInternal(
      taskId,
      clampWaitTimeoutMs(timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
    );
  }

  /** True while the initial assignment is queued or mid-write. Tasks created without a
   *  prompt never have an assignment, though assignedPromptDelivered stays unset. */
  private awaitingInitialPrompt(task: CoordinatedTask): boolean {
    if (task.assignedPromptDelivered) return false;
    return Boolean(task.initialPrompt) || this.writingPromptTaskIds.has(task.id);
  }

  private hasUndeliveredPrompt(task: CoordinatedTask): boolean {
    return this.awaitingInitialPrompt(task) || this.hasQueuedWork(task);
  }

  /** Queued prompts, or a typed body still waiting for its Enter. */
  private hasQueuedWork(task: CoordinatedTask): boolean {
    return Boolean(task.pendingPrompts?.length) || task.unsubmittedPrompt === true;
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
    // An errored task never reaches idle; 'exited' is the closest terminal reason.
    if (task.status === 'error') return Promise.resolve({ reason: 'exited' });
    // Idle only counts once the assignment was delivered and nothing is queued;
    // otherwise the ❯ seen so far is the startup prompt, not finished work.
    if (task.status === 'idle' && !this.hasUndeliveredPrompt(task)) {
      return Promise.resolve({ reason: 'idle' });
    }

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

    const truncatedDiff = truncateDiffForTool(filteredDiff);
    if (truncatedDiff.truncated) {
      return {
        files: filteredFiles,
        diff: truncatedDiff.diff,
        truncated: true,
        originalSizeBytes: truncatedDiff.originalSizeBytes,
      };
    }
    return { files: filteredFiles, diff: truncatedDiff.diff };
  }

  getTaskOutput(taskId: string): string {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // A full-screen TUI such as Codex repaints cells in place, so its raw output
    // strips to word fragments; the rendered screen is what the user reads.
    // shortcut: visible rows only, so text scrolled out of the TUI is gone —
    // read the mirror's scrollback too if callers need earlier turns.
    // Output a few ms behind is fine, so don't wait for the mirror to catch up.
    const screen = getAgentPromptSnapshot(task.agentId, { parsedSoFar: true });
    if (screen?.alternateScreen) return screen.text;
    // Try scrollback buffer first, fall back to tail buffer
    const scrollback = getAgentScrollback(task.agentId);
    if (scrollback) {
      const decoded = Buffer.from(scrollback, 'base64').toString('utf8');
      return stripAnsi(decoded);
    }
    return stripAnsi(this.tailBuffers.get(task.agentId) ?? '');
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

  /** Drop the per-agent output buffers (tail, bracketed-paste flag, decoder) and hook state. */
  private clearAgentBuffers(agentId: string): void {
    this.tailBuffers.delete(agentId);
    this.bracketedPasteAgentIds.delete(agentId);
    this.decoders.delete(agentId);
    this.hookLiveAgentIds.delete(agentId);
    this.interruptedAt.delete(agentId);
  }

  private clearAgentOutputState(task: CoordinatedTask): void {
    this.unsubscribeAgentOutput(task.agentId);
    this.clearAgentBuffers(task.agentId);
  }

  private clearTaskMcpConfig(task: CoordinatedTask): void {
    unlinkMcpConfigFile(task.mcpConfigPath);
    task.mcpConfigPath = undefined;
  }

  private clearTaskControlState(taskId: string): void {
    this.clearPromptDeliveryState(taskId);
    this.controlMap.delete(taskId);
  }

  private agentIdsForTask(task: CoordinatedTask): string[] {
    return [
      ...new Set([
        task.agentId,
        ...getActiveAgentIds().filter((agentId) => getAgentMeta(agentId)?.taskId === task.id),
      ]),
    ];
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

  private async cleanupLandedTaskResources(
    task: CoordinatedTask,
    merged: MergedLines,
  ): Promise<void> {
    this.closingTaskIds.add(task.id);
    try {
      this.notifications.suppressPendingNotificationForTask(task);
      this.notifications.queueLandedNotification(task);

      this.clearAgentOutputState(task);

      const agentIds = this.agentIdsForTask(task);
      for (const agentId of agentIds) {
        try {
          killAgent(agentId);
        } catch {
          /* already dead */
        }
      }

      await deleteTask({
        agentIds,
        branchName: task.branchName,
        deleteBranch: true,
        projectRoot: task.projectRoot,
      });

      this.resolveIdleWaiters(task.id, 'exited');
      this.clearTaskMcpConfig(task);
      task.status = 'exited';
      task.exitCode = 0;
      this.tasks.delete(task.id);
      this.clearTaskControlState(task.id);
      this.notifyRenderer(IPC.MCP_TaskClosed, { taskId: task.id, merged });
    } finally {
      this.closingTaskIds.delete(task.id);
    }
  }

  async landSelf(taskId: string, input: LandSelfInput): Promise<ApiLandSelfResult> {
    this.assertOrchestrationEnabled();
    const epoch = this.orchestrationEpoch;
    return this.withTaskIntegration(taskId, () =>
      this.landing.landSelfUnchecked(taskId, input, epoch),
    );
  }

  private async withTaskIntegration<T>(taskId: string, run: () => Promise<T>): Promise<T> {
    if (this.integratingTaskIds.has(taskId) || this.closingTaskIds.has(taskId)) {
      throw new Error('Task integration or cleanup is already in progress.');
    }
    this.integratingTaskIds.add(taskId);
    try {
      return await run();
    } finally {
      this.integratingTaskIds.delete(taskId);
    }
  }

  markTaskReviewed(taskId: string): void {
    this.landing.markTaskReviewed(taskId);
  }

  async mergeTask(
    taskId: string,
    opts?: { squash?: boolean; message?: string; cleanup?: boolean; skipVerification?: boolean },
  ): Promise<{ mainBranch: string; linesAdded: number; linesRemoved: number }> {
    this.assertOrchestrationEnabled();
    const epoch = this.orchestrationEpoch;
    return this.withTaskIntegration(taskId, () =>
      this.landing.mergeTaskUnchecked(taskId, opts, epoch),
    );
  }

  /** The user merged this child through the desktop Finish dialog; that merge is the review. */
  recordUserMerge(taskId: string): void {
    this.landing.recordUserMerge(taskId);
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
    this.assertOrchestrationEnabled();
    if (this.integratingTaskIds.has(taskId)) throw new Error('Task integration is in progress.');
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    await this.cleanupTask(taskId);
  }

  /**
   * Flag a child its coordinator no longer needs. Only the user closes it, so the
   * agent and worktree stay untouched; waits just stop counting it.
   */
  suggestClose(taskId: string, reason: string): CloseSuggestion {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const suggestion = parseCloseSuggestion({ reason, at: new Date().toISOString() });
    if (!suggestion) throw new Error('A close suggestion needs a short, nonempty reason.');
    task.closeSuggestion = suggestion;
    this.notifyRenderer(IPC.MCP_TaskStateSync, { taskId, closeSuggestion: suggestion });
    this.signalWaits.resolveSignalWaitersIfNoneRemain(task.coordinatorTaskId);
    return suggestion;
  }

  /**
   * Archive a child the coordinator no longer needs: the app collapses it, which
   * stops its agent but keeps the worktree, so the user can restore or close it.
   * The reason is recorded as a close suggestion. Unless forced, a child with work
   * at stake is left alone and the blockers are returned so the parent can decide.
   */
  async archiveTask(taskId: string, reason: string, force = false): Promise<ArchiveResult> {
    const current = this.assertArchivable(taskId);
    // Repeating the call must not report an archived child as left alone.
    if (current.archived && current.closeSuggestion) {
      // The app may have skipped the first collapse (e.g. mid-close); asking again lets it catch up.
      this.notifyRenderer(IPC.MCP_TaskStateSync, { taskId, archived: true });
      return { ...current.closeSuggestion, archived: true };
    }
    const blockers = force ? undefined : await this.archiveBlockers(taskId);
    // Git status yields to other work; the child may have changed hands meanwhile.
    const task = this.assertArchivable(taskId);
    if (blockers && blockers.blockers.length > 0) return { archived: false, ...blockers };
    const suggestion = this.suggestClose(taskId, reason);
    task.archived = true;
    // A restore must not replay instructions the parent has since given up on.
    this.discardAutomatedPrompts(task);
    // The parent just gave this child up; a staged "ready for review" would only nag it.
    this.notifications.suppressPendingNotificationForTask(task, true);
    this.notifyRenderer(IPC.MCP_TaskStateSync, { taskId, archived: true });
    return { ...suggestion, archived: true };
  }

  private assertArchivable(taskId: string): CoordinatedTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (this.closingTaskIds.has(taskId) || this.integratingTaskIds.has(taskId))
      throw new Error('Task is closing or being integrated; it cannot be archived now.');
    // The app may not show the task yet, so it could not collapse it.
    if (task.status === 'creating')
      throw new Error('Task is still being created; wait for it to start before archiving.');
    // Forcing must never stop an agent out from under the user.
    if (this.controlMap.get(taskId) === 'human')
      throw new Error('The user has taken over this task; leave archiving it to them.');
    return task;
  }

  /** What archiving would cut short: a working agent, the user's input, or unsaved work. */
  private async archiveBlockers(
    taskId: string,
  ): Promise<{ blockers: ArchiveBlocker[]; changedFiles?: string[] }> {
    const worktree = await this.worktreeArchiveBlocker(taskId);
    // Read the agent only after git returns: a turn may have started meanwhile.
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const blockers: ArchiveBlocker[] = [];
    const input = task.agentId ? getAgentInputBlocker(task.agentId) : null;
    // An idle child has a live terminal, so 'busy' means a peer prompt or handoff is under way;
    // an exited child is 'busy' only because it has no terminal.
    if (
      task.status === 'running' ||
      this.writingPromptTaskIds.has(taskId) ||
      (input === 'busy' && task.status === 'idle')
    )
      blockers.push('agent-working');
    if (input === 'unsent-input' || input === 'recent-input') blockers.push(input);
    // Committed work the user has not reviewed yet; archiving would withdraw its notification.
    // A merge the user made and kept the task after marks it reviewed.
    if (
      task.signalDoneAt &&
      task.integrationPolicy !== 'automatic' &&
      task.landingState !== 'reviewed'
    )
      blockers.push('unreviewed-result');
    if (!worktree) return { blockers };
    blockers.push(worktree.blocker);
    return worktree.changedFiles ? { blockers, changedFiles: worktree.changedFiles } : { blockers };
  }

  private async worktreeArchiveBlocker(
    taskId: string,
  ): Promise<{ blocker: ArchiveBlocker; changedFiles?: string[] } | null> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    try {
      const paths = await ownDirtyPaths(task.worktreePath);
      if (paths.length === 0) return null;
      return {
        blocker: 'uncommitted-changes',
        changedFiles: paths.slice(0, ARCHIVE_CHANGED_FILES_MAX),
      };
    } catch (err) {
      logWarn('coordinator.archive', 'could not read worktree status', {
        taskId,
        err: String(err),
      });
      return { blocker: 'changes-unknown' };
    }
  }

  /**
   * Remove a coordinated task's backend state when the UI closes it directly.
   * Unlike cleanupTask, this does NOT kill the agent or delete the worktree —
   * the UI has already done both. It only cleans up in-memory coordinator state.
   */
  removeCoordinatedTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    this.notifications.suppressPendingNotificationForTask(task, true);

    this.clearAgentOutputState(task);
    this.resolveIdleWaiters(taskId, 'removed');
    this.clearTaskMcpConfig(task);

    // For Docker sub-tasks, the UI calls killAgent before removeCoordinatedTask,
    // which stops the sub-task's own container via stopDockerContainer in pty.ts.
    // No additional docker cleanup needed here.

    this.tasks.delete(taskId);
    this.clearTaskControlState(taskId);
    this.signalWaits.resolveSignalWaitersIfNoneRemain(task.coordinatorTaskId);
  }

  /** `merged` says the task leaves because it was merged (for the renderer's
   *  Super Productivity note); a plain close or failed start passes nothing. */
  private cleanupTask(taskId: string, merged?: MergedLines): Promise<void> {
    // Concurrent closes share one run so deleteTask is not issued twice.
    const inFlight = this.cleanupsInFlight.get(taskId);
    if (inFlight) return inFlight;
    const run = this.cleanupTaskOnce(taskId, merged).finally(() => {
      this.cleanupsInFlight.delete(taskId);
    });
    this.cleanupsInFlight.set(taskId, run);
    return run;
  }

  private async cleanupTaskOnce(taskId: string, merged?: MergedLines): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    // An exit before this close was already reported; only one landing during it is new.
    const exitedBeforeClose = task.status === 'exited';
    this.closingTaskIds.add(taskId);
    this.notifications.suppressPendingNotificationForTask(task, true);

    this.unsubscribeAgentOutput(task.agentId);
    // A verify run still going would keep writing into the worktree we delete.
    verificationRunner.cancel(taskId);

    // Kill the agent. For Docker sub-tasks, killAgent also calls docker stop on the
    // sub-task's own container (via stopDockerContainer in pty.ts), which cleanly
    // terminates the entire container rather than just the PTY client process.
    const agentIds = this.agentIdsForTask(task);
    for (const agentId of agentIds) {
      try {
        killAgent(agentId);
      } catch {
        /* already dead */
      }
    }

    // Remove worktree. If this fails, keep all coordinator state so the caller
    // can retry. Do NOT emit MCP_TaskClosed — the task still exists on disk.
    try {
      await deleteTask({
        agentIds,
        branchName: task.branchName,
        deleteBranch: true,
        projectRoot: task.projectRoot,
      });
    } catch (err) {
      console.warn('Failed to delete coordinated task worktree:', err);
      this.clearPromptDeliveryState(taskId);
      this.closingTaskIds.delete(taskId);
      // The exit handler skips signal waiters while a task is closing, so an
      // exit that landed during this attempt would otherwise leave them hanging.
      if (!exitedBeforeClose && task.status === 'exited')
        this.signalWaits.deliverExitToSignalWaiter(task);
      this.notifyRenderer(IPC.MCP_TaskCleanupFailed, {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      // The agent that asked for the close must not be told the task is gone.
      throw err;
    }

    // Clean up internal state — resolve idle and signal waiters before deleting
    // so callers don't hang until their own timeout fires.
    this.resolveIdleWaiters(taskId, 'exited');
    // Guard against double-resolve: the PTY exit handler (onPtyEvent 'exit') may have
    // already consumed a resolver if the process exited between killAgent and here.
    // reviewNotificationQueued is set by whichever path runs first.
    if (!task.reviewNotificationQueued) this.signalWaits.deliverExitToSignalWaiter(task);
    this.clearAgentBuffers(task.agentId);
    this.clearTaskMcpConfig(task);
    this.tasks.delete(taskId);
    this.clearTaskControlState(taskId);
    this.closingTaskIds.delete(taskId);

    // Notify renderer
    this.notifyRenderer(IPC.MCP_TaskClosed, merged ? { taskId, merged } : { taskId });
  }

  getTask(taskId: string): CoordinatedTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Dirs a Docker sub-task container must mount to start the coordinator's MCP
   * server: its copy of mcp-server.cjs and the per-sub-task config sit together
   * in the coordinator's `.parallel-code/`, wherever that worktree lives.
   */
  getDockerMcpMounts(taskId: string): string[] | undefined {
    const task = this.tasks.get(taskId);
    const state = task && this.coordinators.get(task.coordinatorTaskId);
    if (!state?.dockerContainerName || !state.mcpServerInfo) return undefined;
    return [dirname(state.mcpServerInfo.serverPath)];
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
    integrationPolicy?: IntegrationPolicy;
    signalDoneAt?: string;
    signalDoneConsumed?: boolean;
    closeSuggestion?: CloseSuggestion;
    /** The app restored this child collapsed. */
    archived?: boolean;
    completion?: CompletionRecord;
    reviewRevision?: number;
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
    const coordinatorState = this.coordinators.get(opts.coordinatorTaskId);
    if (!coordinatorState) {
      throw new Error(`coordinator ${opts.coordinatorTaskId} is not registered`);
    }

    const serverInfo = coordinatorState.mcpServerInfo;
    const safeMcpConfigPath = isAllowedSubTaskMcpConfigPath(opts.mcpConfigPath, {
      taskId: opts.id,
      serverPath: serverInfo?.serverPath,
      dockerContainerName: coordinatorState.dockerContainerName ?? null,
    })
      ? opts.mcpConfigPath
      : undefined;

    const existingTask = this.tasks.get(opts.id);
    if (existingTask) {
      if (!this.orchestrationEnabled) this.discardAutomatedPrompts(existingTask);
      if (safeMcpConfigPath) existingTask.mcpConfigPath = safeMcpConfigPath;
      const mcpLaunchArgs = this.rewriteHydratedSubtaskMcpConfig(
        existingTask,
        opts.coordinatorTaskId,
        safeMcpConfigPath ?? existingTask.mcpConfigPath,
        opts.agentCommand,
      );
      // A renderer reload may have missed the publication event. Send the live
      // record back, rather than letting an older saved report replace it.
      this.notifyRenderer(IPC.MCP_TaskStateSync, {
        taskId: existingTask.id,
        completion: existingTask.completion ?? null,
        reviewRevision: existingTask.reviewRevision ?? 0,
        signalDoneReceived: existingTask.signalDoneAt !== undefined,
        signalDoneAt: existingTask.signalDoneAt?.toISOString() ?? null,
        signalDoneConsumed: existingTask.signalDoneConsumed ?? false,
        closeSuggestion: existingTask.closeSuggestion ?? null,
        // Re-sends a collapse request a reloading renderer may have missed.
        ...(existingTask.archived ? { archived: true } : {}),
      });
      return { mcpLaunchArgs };
    }

    const completion = parseCompletionRecord(opts.completion);
    const task: CoordinatedTask = {
      id: opts.id,
      name: opts.name,
      projectId: opts.projectId,
      projectRoot: opts.projectRoot,
      branchName: opts.branchName,
      baseBranch: opts.baseBranch,
      integrationPolicy: opts.integrationPolicy ?? 'automatic',
      worktreePath: opts.worktreePath,
      agentId: opts.agentId,
      coordinatorTaskId: opts.coordinatorTaskId,
      status: 'exited',
      exitCode: null,
      initialPrompt: opts.initialPrompt,
      pendingPrompts: opts.pendingPrompts?.length ? [...opts.pendingPrompts] : undefined,
      assignedPromptDelivered: opts.assignedPromptDelivered ?? !opts.initialPrompt,
      promptQueuedAt: opts.initialPrompt || opts.pendingPrompts?.length ? Date.now() : undefined,
      signalDoneAt: opts.signalDoneAt ? new Date(opts.signalDoneAt) : undefined,
      signalDoneConsumed: opts.signalDoneConsumed,
      closeSuggestion: parseCloseSuggestion(opts.closeSuggestion),
      archived: opts.archived === true || undefined,
      completion,
      reviewRevision: Math.max(
        Number.isSafeInteger(opts.reviewRevision) && (opts.reviewRevision ?? -1) >= 0
          ? (opts.reviewRevision ?? 0)
          : 0,
        completion?.reviewRevision ?? 0,
      ),
      verification: opts.verification,
      landingState: opts.landingState,
      landingReason: opts.landingReason,
      landingSummary: opts.landingSummary,
      landedMetadata: opts.landedMetadata,
      preambleFileExistedBefore: opts.preambleFileExistedBefore,
    };
    this.tasks.set(task.id, task);
    if (!this.orchestrationEnabled) this.discardAutomatedPrompts(task);
    if (opts.landedMetadata) {
      this.landing.seedLandedOrder(opts.coordinatorTaskId, opts.landedMetadata.landedOrder);
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
      const outputCb = this.createAgentOutputMonitor(task);
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

  /** Called after IPC installs the new launch identity, before replacing its PTY. */
  refreshSessionMcp(
    taskId: string,
    agentCommand: string,
  ): { mcpLaunchArgs?: string[]; mcpConfigPath?: string } {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return {
      mcpLaunchArgs: this.rewriteHydratedSubtaskMcpConfig(
        task,
        task.coordinatorTaskId,
        task.mcpConfigPath,
        agentCommand,
      ),
      mcpConfigPath: task.mcpConfigPath,
    };
  }

  private rewriteHydratedSubtaskMcpConfig(
    task: CoordinatedTask,
    coordinatorTaskId: string,
    mcpConfigPath: string | undefined,
    agentCommand: string | undefined,
  ): string[] | undefined {
    return rewriteSubtaskMcpConfig(
      task,
      this.coordinators.get(coordinatorTaskId),
      this.sessionMcpProvider,
      mcpConfigPath,
      agentCommand,
    );
  }

  isRegisteredCoordinator(coordinatorTaskId: string): boolean {
    return this.coordinators.has(coordinatorTaskId);
  }

  /** Applies to later admissions only; children already in flight keep running. */
  setMaxConcurrentSubTasks(coordinatorTaskId: string, value: number): void {
    const state = this.coordinators.get(coordinatorTaskId);
    if (state) state.maxConcurrentSubTasks = clampCoordinatorConcurrentTasks(value);
  }

  registerCoordinator(
    coordinatorTaskId: string,
    projectId: string,
    opts?: {
      projectRoot?: string;
      spawnDefaults?: { command: string; args: string[] };
      agentEnvFile?: string;
      automaticNotifications?: boolean;
      paused?: boolean;
      branchName?: string;
      worktreePath?: string;
      skipPermissions?: boolean;
      maxConcurrentTasks?: number;
      /** Empty string clears a previously configured command. */
      verifyCommand?: string;
    },
  ): void {
    const existing = this.coordinators.get(coordinatorTaskId);
    if (existing) {
      if (opts?.branchName) existing.branchName = opts.branchName;
      if (opts?.worktreePath) existing.worktreePath = opts.worktreePath;
      if (opts?.maxConcurrentTasks !== undefined) {
        existing.maxConcurrentSubTasks = clampCoordinatorConcurrentTasks(opts.maxConcurrentTasks);
      }
      if (opts?.verifyCommand !== undefined) {
        existing.verifyCommand = opts.verifyCommand.trim() || undefined;
      }
      return;
    }
    // Snapshot the current global project root and defaults so each coordinator gets
    // the values that were active when IT registered, not whatever a later coordinator sets.
    this.coordinators.set(coordinatorTaskId, {
      taskId: coordinatorTaskId,
      lifecycle: 'starting',
      projectId,
      projectRoot: opts?.projectRoot ?? this.projectRoot ?? '',
      branchName: opts?.branchName,
      worktreePath: opts?.worktreePath,
      mcpServerInfo: null,
      spawnDefaults: { ...(opts?.spawnDefaults ?? this.coordinatorSpawnDefaults) },
      agentEnvFile: opts?.agentEnvFile ?? this.coordinatorAgentEnvFile,
      automaticNotifications: opts?.automaticNotifications ?? true,
      paused: opts?.paused ?? false,
      launchEpoch: 0,
      pendingNotifications: [],
      stagedBatches: new Map(),
      ackedBatchIds: [],
      restageTimer: null,
      propagateSkipPermissions: Boolean(opts?.skipPermissions),
      maxConcurrentSubTasks:
        opts?.maxConcurrentTasks !== undefined
          ? clampCoordinatorConcurrentTasks(opts.maxConcurrentTasks)
          : undefined,
      verifyCommand: opts?.verifyCommand?.trim() || undefined,
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
    if (
      [...this.tasks.values()].some(
        (task) =>
          task.coordinatorTaskId === coordinatorTaskId && this.integratingTaskIds.has(task.id),
      )
    )
      throw new Error('Child integration is in progress.');
    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (!coordinator) return;
    coordinator.lifecycle = 'closing';
    this.notifications.clearForDeregister(coordinator);

    restoreCoordinatorMcpJson(coordinator);

    this.coordinators.delete(coordinatorTaskId);
    this.landing.forgetCoordinator(coordinatorTaskId);

    // Resolve any pending wait_for_signal_done calls so they don't hang until
    // the 5-minute timeout fires after the coordinator closes.
    this.signalWaits.resolveForDeregister(coordinatorTaskId);

    // Mark all child tasks belonging to this coordinator as orphaned so that
    // signal_done calls from still-running sub-tasks can still resolve.
    // Do NOT delete the task records — they must remain so signal_done can find them.
    for (const [taskId, task] of this.tasks) {
      if (task.coordinatorTaskId !== coordinatorTaskId) continue;

      this.clearAgentOutputState(task);
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

      this.clearTaskMcpConfig(task);

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
    this.notifications.rescheduleRestageTimer(coordinatorTaskId);
  }

  dropNotification(coordinatorTaskId: string, batchId: string): void {
    this.notifications.dropNotification(coordinatorTaskId, batchId);
  }

  ackNotification(coordinatorTaskId: string, batchId: string): void {
    this.notifications.ackNotification(coordinatorTaskId, batchId);
  }

  hasActiveCoordinator(): boolean {
    return this.coordinators.size > 0;
  }

  hasActiveLegacyCoordinator(): boolean {
    return [...this.coordinators.values()].some(
      (parent) => parent.automaticNotifications !== false,
    );
  }

  private withdrawCloseSuggestion(task: CoordinatedTask): void {
    if (!task.closeSuggestion) return;
    task.closeSuggestion = undefined;
    this.notifyRenderer(IPC.MCP_TaskStateSync, { taskId: task.id, closeSuggestion: null });
  }

  private advanceReviewRevision(task: CoordinatedTask): number {
    task.reviewRevision = (task.reviewRevision ?? 0) + 1;
    this.notifyRenderer(IPC.MCP_TaskStateSync, {
      taskId: task.id,
      reviewRevision: task.reviewRevision,
    });
    return task.reviewRevision;
  }

  signalDone(
    taskId: string,
    input: unknown = {},
    assertCallerCurrent?: () => void,
  ): Promise<SignalDoneResult> {
    return this.signalWaits.signalDone(taskId, input, assertCallerCurrent);
  }

  /** `signal` aborts when the caller is gone (HTTP request closed, tool call cancelled): its
   *  waiter must not take the next completion, or the coordinator never sees it. */
  waitForSignalDone(
    coordinatorTaskId: string,
    rawTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    options: { requestId?: string; signal?: AbortSignal } = {},
  ): Promise<WaitForSignalDoneResult> {
    return this.signalWaits.waitForSignalDone(coordinatorTaskId, rawTimeoutMs, options);
  }

  private notifyRenderer(channel: string, data: unknown): void {
    this.notify?.(channel, data);
  }
}
