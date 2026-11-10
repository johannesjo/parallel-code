// Main-process coordinator for managing sub-agent tasks.
// Manages task lifecycle independently of the SolidJS renderer,
// using existing backend primitives (pty, git, tasks).

import { refreshChildMcpConfigs, type SessionMcpProvider } from './coordinator/mcp-config.js';
import type { CoordinatorInternals } from './coordinator/internals.js';
import { CoordinatorNotifications } from './coordinator/notifications.js';
import { CoordinatorLanding } from './coordinator/landing.js';
import { ChildArchiver } from './coordinator/archive.js';
import { CoordinatorPrompts } from './coordinator/prompts.js';
import { DEFAULT_WAIT_TIMEOUT_MS, SignalWaits } from './coordinator/signal-waits.js';
import type { Notify } from '../ipc/notify.js';
import { clampCoordinatorConcurrentTasks } from '../shared/coordinator-limits.js';
import { info as logInfo } from '../log.js';
import type {
  CoordinatedTask,
  CoordinatorState,
  ApiTaskSummary,
  ApiTaskDetail,
  ApiDiffResult,
  ApiLandSelfResult,
  ArchiveResult,
  LandSelfInput,
  WaitForSignalDoneResult,
} from './types.js';
import { IPC } from '../ipc/channels.js';
import { parseCloseSuggestion, type CloseSuggestion } from '../shared/close-suggestion.js';
import { type SignalDoneResult } from '../shared/completion-report.js';
import {
  assertOrchestrationEnabled,
  withdrawCloseSuggestion,
  advanceReviewRevision,
  isClosingOrIntegrating,
  notifyRenderer,
  resolveIdleWaiters,
} from './coordinator/internals.js';
import { listenToAgentEvents } from './coordinator/agent-events.js';
import { waitForIdle } from './coordinator/idle-waits.js';
import {
  listTasks,
  getTaskStatus,
  getTaskDiff,
  getTaskOutput,
} from './coordinator/task-queries.js';
import { stopChildren, resumeChildren, reserveChildRestart } from './coordinator/admission.js';
import {
  cleanupLandedTaskResources,
  closeTask,
  removeCoordinatedTask,
  cleanupTask,
  detachChildren,
  detachChild,
  deregisterCoordinator,
} from './coordinator/teardown.js';
import { createTask, getDockerMcpMounts } from './coordinator/task-creation.js';
import type { CreateTaskOptions } from './coordinator/task-creation.js';
import { hydrateTask, refreshSessionMcp } from './coordinator/task-hydration.js';
import type { HydrateTaskOptions } from './coordinator/task-hydration.js';

export class Coordinator implements CoordinatorInternals {
  // The fields are this class's own state. Those without `private` are public
  // only so the function modules in ./coordinator/ can work on them through
  // CoordinatorInternals; nothing else should.
  tasks = new Map<string, CoordinatedTask>();
  tailBuffers = new Map<string, string>();
  idleResolvers = new Map<
    string,
    Array<(result: { reason: 'idle' | 'human_control' | 'exited' | 'removed' }) => void>
  >();
  subscribers = new Map<string, (encoded: string) => void>();
  decoders = new Map<string, TextDecoder>();
  controlMap = new Map<string, 'coordinator' | 'human'>();
  private writingPromptTaskIds = new Set<string>();
  private initialPromptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private initialPromptReadyTasks = new Set<string>();
  promptReadySeenAt = new Map<string, number>();
  private queuedPromptFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  bracketedPasteAgentIds = new Set<string>();
  closingTaskIds = new Set<string>();
  cleanupsInFlight = new Map<string, Promise<void>>();
  integratingTaskIds = new Set<string>();
  orchestrationEnabled = true;
  orchestrationEpoch = 0;

  setOrchestrationEnabled(enabled: boolean): void {
    if (this.orchestrationEnabled === enabled) return;
    this.orchestrationEnabled = enabled;
    if (enabled) return;
    this.orchestrationEpoch += 1;
    for (const parent of this.coordinators.values())
      parent.launchEpoch = (parent.launchEpoch ?? 0) + 1;
    for (const task of this.tasks.values()) this.prompts.discardAutomatedPrompts(task);
  }

  sessionMcpProvider?: SessionMcpProvider;

  setSessionMcpProvider(provider: SessionMcpProvider): void {
    this.sessionMcpProvider = provider;
  }
  // Agents that have delivered at least one hook event this session. Hooks own
  // idle/running transitions for these; the output-regex path only feeds
  // prompt-injection readiness. Cleared on PTY exit/respawn (fresh session)
  // and on a user interrupt (no Stop hook follows one).
  hookLiveAgentIds = new Set<string>();
  // When each agent was last interrupted; see HOOK_INTERRUPT_SUPPRESS_MS.
  interruptedAt = new Map<string, number>();
  // Sub-task creations past the concurrency check but not yet in this.tasks,
  // so parallel create_task calls can't overshoot the limit.
  pendingCreateCounts = new Map<string, number>();
  notify: Notify | null = null;
  projectRoot: string | null = null;
  projectId: string | null = null;
  defaultCoordinatorTaskId: string | null = null;
  private coordinatorSpawnDefaults: { command: string; args: string[] } = {
    command: 'claude',
    args: [],
  };
  private coordinatorAgentEnvFile: string | undefined;
  coordinators = new Map<string, CoordinatorState>();
  // Serializes concurrent preamble writes to the same file path.
  preambleWriteQueue = new Map<string, Promise<void>>();
  notifications: CoordinatorNotifications = new CoordinatorNotifications({
    coordinators: this.coordinators,
    tasks: this.tasks,
    activeSignalWaitCount: (coordinatorTaskId) =>
      this.signalWaits.activeSignalWaitCount(coordinatorTaskId),
    suppressPromptEchoIdleIfNeeded: (task) => this.prompts.suppressPromptEchoIdleIfNeeded(task),
    notifyRenderer: (channel, data) => notifyRenderer(this, channel, data),
  });
  landing: CoordinatorLanding = new CoordinatorLanding({
    tasks: this.tasks,
    coordinators: this.coordinators,
    notifications: this.notifications,
    assertOrchestrationEnabled: (epoch) => assertOrchestrationEnabled(this, epoch),
    cleanupLandedTaskResources: (task, merged) => cleanupLandedTaskResources(this, task, merged),
    cleanupTask: (taskId, merged) => cleanupTask(this, taskId, merged),
    notifyRenderer: (channel, data) => notifyRenderer(this, channel, data),
  });
  private archiver = new ChildArchiver({
    tasks: this.tasks,
    notifications: this.notifications,
    isClosingOrIntegrating: (taskId) => isClosingOrIntegrating(this, taskId),
    isHumanControlled: (taskId) => this.controlMap.get(taskId) === 'human',
    isWritingPrompt: (taskId) => this.writingPromptTaskIds.has(taskId),
    suggestClose: (taskId, reason) => this.suggestClose(taskId, reason),
    discardAutomatedPrompts: (task) => this.prompts.discardAutomatedPrompts(task),
    notifyRenderer: (channel, data) => notifyRenderer(this, channel, data),
  });
  prompts: CoordinatorPrompts = new CoordinatorPrompts(
    {
      tasks: this.tasks,
      controlMap: this.controlMap,
      hookLiveAgentIds: this.hookLiveAgentIds,
      idleResolvers: this.idleResolvers,
      notifications: this.notifications,
      isOrchestrationEnabled: () => this.orchestrationEnabled,
      orchestrationEpoch: () => this.orchestrationEpoch,
      assertOrchestrationEnabled: (epoch) => assertOrchestrationEnabled(this, epoch),
      advanceReviewRevision: (task) => advanceReviewRevision(this, task),
      withdrawCloseSuggestion: (task) => withdrawCloseSuggestion(this, task),
      notifyRenderer: (channel, data) => notifyRenderer(this, channel, data),
    },
    {
      tailBuffers: this.tailBuffers,
      decoders: this.decoders,
      writingPromptTaskIds: this.writingPromptTaskIds,
      initialPromptTimers: this.initialPromptTimers,
      initialPromptReadyTasks: this.initialPromptReadyTasks,
      promptReadySeenAt: this.promptReadySeenAt,
      queuedPromptFlushTimers: this.queuedPromptFlushTimers,
      bracketedPasteAgentIds: this.bracketedPasteAgentIds,
    },
  );
  signalWaits: SignalWaits = new SignalWaits({
    tasks: this.tasks,
    coordinators: this.coordinators,
    notifications: this.notifications,
    isClosingOrIntegrating: (taskId) => isClosingOrIntegrating(this, taskId),
    withdrawCloseSuggestion: (task) => withdrawCloseSuggestion(this, task),
    stalledChildren: (coordinatorTaskId) => this.prompts.stalledChildren(coordinatorTaskId),
    notifyRenderer: (channel, data) => notifyRenderer(this, channel, data),
  });
  constructor() {
    // The singleton guard in enableCoordinatorMode (if (coordinator) return) ensures
    // this constructor is called at most once per app lifetime; no teardown needed.
    listenToAgentEvents(this);
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
      resolveIdleWaiters(this, taskId, 'human_control');
    }
    if (who === 'coordinator') {
      // A body typed before its Enter failed is queued work too: it still needs submitting.
      const hasQueuedWork = Boolean(task.initialPrompt) || this.prompts.hasQueuedWork(task);
      // Fire any idle resolvers queued while human had control
      if (!hasQueuedWork) resolveIdleWaiters(this, taskId, 'idle');
      if (task.initialPrompt) {
        this.prompts.clearInitialPromptTimer(task.id);
        this.prompts.scheduleInitialPromptDelivery(task, 0);
      } else if (hasQueuedWork) {
        // Human use may have left the agent mid-turn; wait for a rendered prompt.
        this.prompts.scheduleQueuedPromptFlush(task);
      }
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

  createTask(opts: CreateTaskOptions): Promise<CoordinatedTask> {
    return createTask(this, opts);
  }

  stopChildren(parentId: string): void {
    stopChildren(this, parentId);
  }

  resumeChildren(parentId: string): void {
    resumeChildren(this, parentId);
  }

  reserveChildRestart(taskId: string): (() => void) & { assertAllowed: () => void } {
    return reserveChildRestart(this, taskId);
  }

  detachChildren(parentId: string): string[] {
    return detachChildren(this, parentId);
  }

  detachChild(childId: string): string | undefined {
    return detachChild(this, childId);
  }

  listTasks(): ApiTaskSummary[] {
    return listTasks(this);
  }

  getTaskStatus(taskId: string): ApiTaskDetail | null {
    return getTaskStatus(this, taskId);
  }

  getTaskDoneToken(taskId: string): string | null {
    return this.tasks.get(taskId)?.doneToken ?? null;
  }

  sendPrompt(taskId: string, prompt: string): Promise<{ queued: boolean }> {
    return this.prompts.sendPrompt(taskId, prompt);
  }

  isAutomationWriteInFlight(taskId: string): boolean {
    return this.tasks.get(taskId)?.automationWriteInFlight === true;
  }

  hasPendingPrompt(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    return !!(task?.initialPrompt || task?.pendingPrompts?.length || task?.automationWriteInFlight);
  }

  waitForIdle(
    taskId: string,
    timeoutMs?: number,
  ): Promise<{ reason: 'idle' | 'human_control' | 'exited' | 'removed' }> {
    return waitForIdle(this, taskId, timeoutMs);
  }

  getTaskDiff(taskId: string): Promise<ApiDiffResult> {
    return getTaskDiff(this, taskId);
  }

  getTaskOutput(taskId: string): string {
    return getTaskOutput(this, taskId);
  }

  async landSelf(taskId: string, input: LandSelfInput): Promise<ApiLandSelfResult> {
    assertOrchestrationEnabled(this);
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
    assertOrchestrationEnabled(this);
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
    const diff = await getTaskDiff(this, taskId);
    const merge = await this.mergeTask(taskId, { ...opts, cleanup: true });
    return { diff, merge };
  }

  closeTask(taskId: string): Promise<void> {
    return closeTask(this, taskId);
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
    notifyRenderer(this, IPC.MCP_TaskStateSync, { taskId, closeSuggestion: suggestion });
    this.signalWaits.resolveSignalWaitersIfNoneRemain(task.coordinatorTaskId);
    return suggestion;
  }

  /**
   * Archive a child the coordinator no longer needs: the app collapses it, which
   * stops its agent but keeps the worktree, so the user can restore or close it.
   */
  archiveTask(taskId: string, reason: string, force = false): Promise<ArchiveResult> {
    return this.archiver.archiveTask(taskId, reason, force);
  }

  removeCoordinatedTask(taskId: string): void {
    removeCoordinatedTask(this, taskId);
  }

  getTask(taskId: string): CoordinatedTask | undefined {
    return this.tasks.get(taskId);
  }

  getDockerMcpMounts(taskId: string): string[] | undefined {
    return getDockerMcpMounts(this, taskId);
  }

  hydrateTask(opts: HydrateTaskOptions): { mcpLaunchArgs?: string[] } {
    return hydrateTask(this, opts);
  }

  refreshSessionMcp(
    taskId: string,
    agentCommand: string,
  ): { mcpLaunchArgs?: string[]; mcpConfigPath?: string } {
    return refreshSessionMcp(this, taskId, agentCommand);
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
    deregisterCoordinator(this, coordinatorTaskId);
  }

  markPromptDelivered(taskId: string): void {
    this.prompts.markPromptDelivered(taskId);
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
}
