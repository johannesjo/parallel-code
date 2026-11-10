// Prompt delivery to a coordinator's children: reading each agent's output for
// a ready input prompt, delivering the initial assignment once the agent can
// take it, queueing follow-up prompts until the next ready prompt, and writing
// them to the PTY.

import { writeToAgent, getAgentScrollback, getAgentPromptSnapshot } from '../../ipc/pty.js';
import {
  stripAnsi,
  cursorRowsToLines,
  chunkContainsAgentPrompt,
  getAgentPromptReadiness,
  AGENT_READY_TAIL_CHARS,
} from '../../shared/prompt-detect.js';
import { isStalled, promptDelivery, type PromptDelivery } from '../prompt-delivery.js';
import { info as logInfo, warn as logWarn } from '../../log.js';
import { IPC } from '../../ipc/channels.js';
import type { CoordinatorNotifications } from './notifications.js';
import type { CoordinatedTask, StalledChild } from '../types.js';

type IdleWaitResult = { reason: 'idle' | 'human_control' | 'exited' | 'removed' };

/**
 * Prompt state the Coordinator creates and passes in by reference: its task
 * teardown clears the per-agent buffers, and its tests inspect the delivery
 * timers and flags. CoordinatorPrompts reads and updates the same collections.
 */
export interface PromptState {
  /** Recent output per agent; a send clears it, so a prompt in it was drawn since. */
  readonly tailBuffers: Map<string, string>;
  readonly decoders: ReadonlyMap<string, TextDecoder>;
  /** Tasks with a prompt write under way. */
  readonly writingPromptTaskIds: Set<string>;
  readonly initialPromptTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Tasks whose agent has drawn a ready prompt, so the initial prompt may go out. */
  readonly initialPromptReadyTasks: Set<string>;
  /** When each task's ready prompt was first seen, to require it to be stable. */
  readonly promptReadySeenAt: Map<string, number>;
  readonly queuedPromptFlushTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly bracketedPasteAgentIds: Set<string>;
}

/** What prompt delivery reads from, and asks of, the coordinator that owns it. */
export interface PromptHost {
  readonly tasks: ReadonlyMap<string, CoordinatedTask>;
  readonly controlMap: ReadonlyMap<string, 'coordinator' | 'human'>;
  /** Agents whose hooks report state; only hooks move them to idle. */
  readonly hookLiveAgentIds: ReadonlySet<string>;
  readonly idleResolvers: Map<string, Array<(result: IdleWaitResult) => void>>;
  readonly notifications: CoordinatorNotifications;
  isOrchestrationEnabled(): boolean;
  orchestrationEpoch(): number;
  /** Throws once orchestration is disabled or the operation's epoch was canceled. */
  assertOrchestrationEnabled(epoch?: number): void;
  advanceReviewRevision(task: CoordinatedTask): number;
  withdrawCloseSuggestion(task: CoordinatedTask): void;
  notifyRenderer(channel: string, data: unknown): void;
}

const PROMPT_WRITE_DELAY_MS = 50;
export const INITIAL_PROMPT_READY_DELAY_MS = 1_500;
const MAX_PENDING_PROMPTS = 32;
const MAX_PROMPT_BYTES = 64 * 1024;
const PROMPT_ECHO_IDLE_SUPPRESSION_MS = 2_000;
// A full-screen TUI shows its input prompt mid-turn too: Codex clears it on
// submit before it shows it is working, and keeps it while streaming a reply.
// Its output only stops once the turn ends, so the prompt counts once output
// has settled. Delegation waits as long but only for readiness to persist,
// which a Codex reply streaming under its prompt would pass.
const PROMPT_SETTLE_MS = 1_500;
const FOCUS_IN = '\x1b[I';
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const TAIL_MAX_CHARS = 4096;

/** The end of the text that is kept as an agent's tail. */
function keepTail(text: string): string {
  return text.length > TAIL_MAX_CHARS ? text.slice(text.length - TAIL_MAX_CHARS) : text;
}

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

export class CoordinatorPrompts {
  // Output whose prompt check waits for the screen mirror or for output to settle.
  private deferredPromptChecks = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; echoOnly: boolean }
  >();

  constructor(
    private readonly host: PromptHost,
    private readonly state: PromptState,
  ) {}

  discardAutomatedPrompts(task: CoordinatedTask): void {
    this.clearInitialPromptDeliveryState(task.id);
    this.clearQueuedPromptFlushTimer(task.id);
    task.initialPrompt = undefined;
    task.pendingPrompts = undefined;
    task.promptQueuedAt = undefined;
    task.unsubmittedPrompt = false;
    this.host.notifyRenderer(IPC.MCP_TaskStateSync, {
      taskId: task.id,
      initialPrompt: null,
      pendingPromptCount: 0,
    });
  }

  private normalizedTail(agentId: string): string {
    const tail = (this.state.tailBuffers.get(agentId) ?? '').slice(-AGENT_READY_TAIL_CHARS * 2);
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
    if (!this.state.tailBuffers.get(task.agentId)) return false;
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
      if (match[1] === 'h') this.state.bracketedPasteAgentIds.add(agentId);
      else this.state.bracketedPasteAgentIds.delete(agentId);
    }
  }

  updateTailFromScrollback(task: CoordinatedTask): boolean {
    const scrollback = getAgentScrollback(task.agentId);
    if (!scrollback) return false;
    const decoded = Buffer.from(scrollback, 'base64').toString('utf8');
    this.updateBracketedPasteMode(task.agentId, decoded);
    this.state.tailBuffers.set(task.agentId, keepTail(decoded));
    const freshPrompt = this.freshAgentPrompt(task);
    // A screen still settling is judged like new output once it has.
    if (freshPrompt === undefined)
      this.deferPromptCheck(task, this.takeDeferredPromptCheck(task.id));
    const hasAgentPrompt = freshPrompt === true;
    if (hasAgentPrompt) {
      this.scheduleInitialPromptDelivery(task, INITIAL_PROMPT_READY_DELAY_MS, true);
      // Replayed scrollback may hold a stale ❯ from a mid-turn frame: hook-live
      // agents go idle on Stop only, and an undelivered assignment is not idle.
      if (!this.awaitingInitialPrompt(task) && !this.host.hookLiveAgentIds.has(task.agentId)) {
        task.status = 'idle';
        this.host.notifications.maybeQueueReviewNotification(task, 'idle', null);
      }
    }
    return hasAgentPrompt;
  }

  private markAgentPromptReady(task: CoordinatedTask, hasAgentPrompt: boolean): boolean {
    if (!hasAgentPrompt) {
      this.state.promptReadySeenAt.delete(task.id);
      return false;
    }
    const now = Date.now();
    const firstSeenAt = this.state.promptReadySeenAt.get(task.id);
    if (firstSeenAt === undefined) {
      this.state.promptReadySeenAt.set(task.id, now);
      return false;
    }
    return now - firstSeenAt >= PROMPT_WRITE_DELAY_MS;
  }

  scheduleQueuedPromptFlush(task: CoordinatedTask): void {
    if (
      !this.host.isOrchestrationEnabled() ||
      !this.hasQueuedWork(task) ||
      this.state.queuedPromptFlushTimers.has(task.id)
    )
      return;
    const timer = setTimeout(() => {
      this.state.queuedPromptFlushTimers.delete(task.id);
      if (!this.host.isOrchestrationEnabled() || !this.host.tasks.has(task.id)) return;
      if (this.host.controlMap.get(task.id) === 'human') return;
      if (!this.hasQueuedWork(task)) return;
      const ready = this.freshAgentPrompt(task);
      if (!ready) {
        if (ready === undefined) this.scheduleQueuedPromptFlush(task);
        return;
      }
      if (this.state.writingPromptTaskIds.has(task.id)) {
        this.scheduleQueuedPromptFlush(task);
        return;
      }
      void this.flushNextQueuedPrompt(task);
    }, PROMPT_WRITE_DELAY_MS);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.state.queuedPromptFlushTimers.set(task.id, timer);
  }

  private clearQueuedPromptFlushTimer(taskId: string): void {
    const timer = this.state.queuedPromptFlushTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.state.queuedPromptFlushTimers.delete(taskId);
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

  suppressPromptEchoIdleIfNeeded(task: CoordinatedTask): boolean {
    if (!task.assignedPromptDelivered || task.suppressIdleUntil === undefined) return false;
    if (Date.now() < task.suppressIdleUntil) {
      task.suppressIdleUntil = undefined;
      task.lastPromptEchoText = undefined;
      this.state.tailBuffers.set(task.agentId, '');
      return true;
    }
    task.suppressIdleUntil = undefined;
    task.lastPromptEchoText = undefined;
    return false;
  }

  clearInitialPromptTimer(taskId: string): void {
    const timer = this.state.initialPromptTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.state.initialPromptTimers.delete(taskId);
  }

  private clearInitialPromptDeliveryState(taskId: string): void {
    this.clearInitialPromptTimer(taskId);
    this.state.initialPromptReadyTasks.delete(taskId);
  }

  clearPromptDeliveryState(taskId: string): void {
    this.clearInitialPromptDeliveryState(taskId);
    this.clearQueuedPromptFlushTimer(taskId);
    this.takeDeferredPromptCheck(taskId);
    this.state.promptReadySeenAt.delete(taskId);
    this.state.writingPromptTaskIds.delete(taskId);
  }

  scheduleInitialPromptDelivery(
    task: CoordinatedTask,
    delayMs = INITIAL_PROMPT_READY_DELAY_MS,
    promptReady = false,
  ): void {
    if (!this.host.isOrchestrationEnabled()) return;
    if (promptReady) this.state.initialPromptReadyTasks.add(task.id);
    if (!task.initialPrompt || task.assignedPromptDelivered) return;
    if (this.state.initialPromptTimers.has(task.id)) return;

    const timer = setTimeout(() => {
      this.state.initialPromptTimers.delete(task.id);
      void this.tryDeliverInitialPrompt(task.id);
    }, delayMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.state.initialPromptTimers.set(task.id, timer);
    logInfo('coordinator.initial_prompt', 'scheduled', {
      taskId: task.id,
      agentId: task.agentId,
      delayMs,
    });
  }

  createAgentOutputMonitor(task: CoordinatedTask): (encoded: string) => void {
    return (encoded: string) => {
      const bytes = Buffer.from(encoded, 'base64');
      const text = (this.state.decoders.get(task.agentId) ?? new TextDecoder()).decode(bytes, {
        stream: true,
      });
      this.updateBracketedPasteMode(task.agentId, text);
      const prev = this.state.tailBuffers.get(task.agentId) ?? '';
      const combined = prev + text;
      this.state.tailBuffers.set(task.agentId, keepTail(combined));
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
      if (!this.host.tasks.has(task.id) || !this.state.tailBuffers.get(task.agentId)) return;
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
    } else if (task.status === 'idle' && !this.host.hookLiveAgentIds.has(task.agentId)) {
      // Hook-live agents flip back to running only on hook evidence — TUI
      // repaints and status-line noise must not override a hook-reported idle.
      task.status = 'running';
      this.host.notifications.suppressPendingNotificationForTask(task);
    }
  }

  handlePromptDetected(
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
      this.host.controlMap.get(task.id) !== 'human' &&
      this.hasQueuedWork(task)
    ) {
      if (stableAgentPrompt && !this.state.writingPromptTaskIds.has(task.id)) {
        void this.flushNextQueuedPrompt(task);
      } else {
        this.scheduleQueuedPromptFlush(task);
      }
      return;
    }
    // Once hooks report state for this agent, only hook Stop events may drive
    // the idle transition — the ❯-regex above still schedules prompt delivery
    // but must not race a mid-turn TUI frame into a false idle.
    if (source === 'regex' && this.host.hookLiveAgentIds.has(task.agentId)) {
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
      this.host.notifications.maybeQueueReviewNotification(task, 'idle', null);
    }
    const resolvers = this.host.idleResolvers.get(task.id);
    if (resolvers?.length) {
      for (const resolve of resolvers) resolve({ reason: 'idle' });
      this.host.idleResolvers.delete(task.id);
    }
  }

  async tryDeliverInitialPrompt(taskId: string): Promise<void> {
    if (!this.host.isOrchestrationEnabled()) return;
    const epoch = this.host.orchestrationEpoch();
    const task = this.host.tasks.get(taskId);
    if (!task?.initialPrompt || task.assignedPromptDelivered) return;
    if (task.status === 'exited' || task.status === 'error') return;

    const readiness = getAgentPromptReadiness(this.normalizedTail(task.agentId));
    // The sticky ready flag only covers a blank tail; a trust dialog, MCP boot or
    // busy marker that appeared since must still block delivery.
    const blocked = readiness.reason === 'startup_or_dialog' || readiness.reason === 'busy';
    const promptReady =
      !blocked && (this.state.initialPromptReadyTasks.has(taskId) || readiness.ready);
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

    if (this.host.controlMap.get(task.id) === 'human') {
      this.scheduleInitialPromptDelivery(task, INITIAL_PROMPT_READY_DELAY_MS, promptReady);
      return;
    }

    if (this.state.writingPromptTaskIds.has(task.id)) return;
    const prompt = task.initialPrompt;
    task.initialPrompt = undefined;
    this.state.writingPromptTaskIds.add(task.id);
    try {
      await this.writePromptToTask(task, prompt);
      this.markPromptDelivered(task.id);
      logInfo('coordinator.initial_prompt', 'delivered', {
        taskId: task.id,
        agentId: task.agentId,
      });
      this.host.notifyRenderer(IPC.MCP_TaskStateSync, {
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
        this.host.notifyRenderer(IPC.MCP_TaskStateSync, {
          taskId: task.id,
          initialPrompt: null,
        });
        return;
      }
      if (
        this.host.isOrchestrationEnabled() &&
        epoch === this.host.orchestrationEpoch() &&
        this.host.tasks.has(task.id)
      ) {
        task.initialPrompt = prompt;
        this.scheduleInitialPromptDelivery(task, INITIAL_PROMPT_READY_DELAY_MS, promptReady);
      }
    } finally {
      this.state.writingPromptTaskIds.delete(task.id);
    }
  }

  async sendPrompt(taskId: string, prompt: string): Promise<{ queued: boolean }> {
    this.host.assertOrchestrationEnabled();
    const task = this.host.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    // Its agent is stopped and only the user can restore it; a queued prompt would never land.
    if (task.archived)
      throw new Error('Task is archived. Ask the user to restore it, or create a new task.');
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES)
      throw new Error(`Prompt exceeds ${MAX_PROMPT_BYTES} byte limit`);
    const queueLen = task.pendingPrompts?.length ?? 0;
    if (queueLen >= MAX_PENDING_PROMPTS)
      throw new Error(`Prompt queue full (${MAX_PENDING_PROMPTS} pending)`);
    this.host.advanceReviewRevision(task);
    // New work means the coordinator wants this child after all, even while it queues.
    this.host.withdrawCloseSuggestion(task);
    if (task.initialPrompt && !task.assignedPromptDelivered) {
      this.queuePrompt(task, prompt);
      this.clearInitialPromptTimer(task.id);
      this.scheduleInitialPromptDelivery(task, 0);
      return { queued: true };
    }
    if (
      task.pendingPrompts?.length ||
      this.host.controlMap.get(taskId) === 'human' ||
      this.state.writingPromptTaskIds.has(taskId)
    ) {
      this.queuePrompt(task, prompt);
      return { queued: true };
    }

    // Acquire write lock synchronously before the first await so a concurrent
    // sendPrompt call sees the lock and queues rather than writing through.
    this.state.writingPromptTaskIds.add(task.id);
    try {
      await this.writePromptToTask(task, prompt);
    } finally {
      this.state.writingPromptTaskIds.delete(task.id);
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
  markPromptStarted(task: CoordinatedTask): void {
    if (task.promptSubmittedAt !== undefined) task.promptStartedAt ??= Date.now();
  }

  promptDelivery(task: CoordinatedTask): PromptDelivery | undefined {
    if (task.status === 'exited' || task.status === 'error') return undefined;
    const now = Date.now();
    const blockedBy =
      this.host.controlMap.get(task.id) === 'human'
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

  stalledChildren(coordinatorTaskId: string): StalledChild[] {
    const stalled: StalledChild[] = [];
    for (const task of this.host.tasks.values()) {
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
      this.host.assertOrchestrationEnabled(epoch);
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
    this.state.tailBuffers.set(task.agentId, '');
    this.state.promptReadySeenAt.delete(task.id);
    this.scheduleQueuedPromptFlush(task);
  }

  private async flushNextQueuedPrompt(task: CoordinatedTask): Promise<void> {
    if (!this.host.isOrchestrationEnabled()) return;
    const epoch = this.host.orchestrationEpoch();
    if (this.host.controlMap.get(task.id) === 'human') return;
    if (task.initialPrompt && !task.assignedPromptDelivered) return;
    if (this.state.writingPromptTaskIds.has(task.id)) return;
    if (task.unsubmittedPrompt) {
      this.submitStrandedPrompt(task, epoch);
      return;
    }
    const prompt = task.pendingPrompts?.shift();
    if (!prompt) {
      task.pendingPrompts = undefined;
      return;
    }
    this.state.writingPromptTaskIds.add(task.id);
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
      } else if (this.host.isOrchestrationEnabled() && epoch === this.host.orchestrationEpoch()) {
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
      this.state.writingPromptTaskIds.delete(task.id);
    }
    if (task.pendingPrompts?.length === 0) {
      task.pendingPrompts = undefined;
    } else if (task.pendingPrompts?.length) {
      this.scheduleQueuedPromptFlush(task);
    }
  }

  private async writePromptToTask(task: CoordinatedTask, prompt: string): Promise<void> {
    this.host.assertOrchestrationEnabled();
    const epoch = this.host.orchestrationEpoch();
    // Send text then Enter separately (like the frontend does)
    this.setAutomationWriteInFlight(task, true);
    try {
      try {
        writeToAgent(task.agentId, FOCUS_IN);
      } catch (err) {
        throw new PromptWriteError('Prompt focus write failed', 'body', err);
      }
      const promptBody = this.state.bracketedPasteAgentIds.has(task.agentId)
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
        bracketedPaste: this.state.bracketedPasteAgentIds.has(task.agentId),
      });
      const submitDelayMs = pasteDelayMs(prompt);
      await new Promise((r) => setTimeout(r, submitDelayMs));
      try {
        this.host.assertOrchestrationEnabled(epoch);
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
      this.state.tailBuffers.set(task.agentId, '');
    } finally {
      this.setAutomationWriteInFlight(task, false);
    }
    this.host.notifyRenderer(IPC.MCP_TaskStateSync, {
      taskId: task.id,
      signalDoneReceived: false,
      signalDoneAt: null,
      signalDoneConsumed: false,
      needsReview: false,
    });
  }

  private setAutomationWriteInFlight(task: CoordinatedTask, value: boolean): void {
    if (task.automationWriteInFlight === value) return;
    task.automationWriteInFlight = value;
    this.host.notifyRenderer(IPC.MCP_TaskStateSync, {
      taskId: task.id,
      automationWriteInFlight: value,
    });
  }

  /** True while the initial assignment is queued or mid-write. Tasks created without a
   *  prompt never have an assignment, though assignedPromptDelivered stays unset. */
  private awaitingInitialPrompt(task: CoordinatedTask): boolean {
    if (task.assignedPromptDelivered) return false;
    return Boolean(task.initialPrompt) || this.state.writingPromptTaskIds.has(task.id);
  }

  hasUndeliveredPrompt(task: CoordinatedTask): boolean {
    return this.awaitingInitialPrompt(task) || this.hasQueuedWork(task);
  }

  /** Queued prompts, or a typed body still waiting for its Enter. */
  hasQueuedWork(task: CoordinatedTask): boolean {
    return Boolean(task.pendingPrompts?.length) || task.unsubmittedPrompt === true;
  }

  markPromptDelivered(taskId: string): void {
    const task = this.host.tasks.get(taskId);
    if (!task) return;
    this.clearPromptDeliveryState(taskId);
    task.initialPrompt = undefined;
    task.assignedPromptDelivered = true;
    task.suppressIdleUntil ??= Date.now() + PROMPT_ECHO_IDLE_SUPPRESSION_MS;
    this.state.tailBuffers.set(task.agentId, '');
    if (task.status !== 'exited' && task.status !== 'error') task.status = 'running';
  }
}
