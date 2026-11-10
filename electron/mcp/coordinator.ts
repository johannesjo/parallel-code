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
  injectSubTaskPreamble,
  restoreSubTaskPreambleInjection,
  type InjectedSubTaskPreamble,
} from './preamble.js';
import { execAsync, execStdout, currentBranch } from './coordinator/child-git.js';
import {
  buildTaskMcpLaunchArgs,
  refreshChildMcpConfigs,
  rewriteSubtaskMcpConfig,
  type SessionMcpProvider,
} from './coordinator/mcp-config.js';
import type { CoordinatorInternals } from './coordinator/internals.js';
import { CoordinatorNotifications } from './coordinator/notifications.js';
import { CoordinatorLanding } from './coordinator/landing.js';
import { ChildArchiver } from './coordinator/archive.js';
import { CoordinatorPrompts, INITIAL_PROMPT_READY_DELAY_MS } from './coordinator/prompts.js';
import { DEFAULT_WAIT_TIMEOUT_MS, SignalWaits } from './coordinator/signal-waits.js';
import type { Notify } from '../ipc/notify.js';
import { createTask as createBackendTask, deleteTask } from '../ipc/tasks.js';
import { getSkipPermissionsArgs, stripPermissionBypassArgs } from '../shared/skip-permissions.js';
import { spawnAgent, killAgent, subscribeToAgent } from '../ipc/pty.js';
import {
  clampCoordinatorConcurrentTasks,
  DEFAULT_COORDINATOR_CONCURRENT_TASKS,
} from '../shared/coordinator-limits.js';
import { getMainBranch } from '../ipc/git.js';
import { buildSubTaskPreamble } from './sub-task-preamble.js';
import { info as logInfo, warn as logWarn } from '../log.js';
import type {
  CoordinatedTask,
  IntegrationPolicy,
  CoordinatorState,
  ApiTaskSummary,
  ApiTaskDetail,
  ApiDiffResult,
  ApiLandSelfResult,
  ArchiveResult,
  LandSelfInput,
  LandingState,
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
import {
  assertOrchestrationEnabled,
  withdrawCloseSuggestion,
  advanceReviewRevision,
  isClosingOrIntegrating,
  notifyRenderer,
} from './coordinator/internals.js';
import { clearAgentBuffers, listenToAgentEvents } from './coordinator/agent-events.js';
import { waitForIdle } from './coordinator/idle-waits.js';
import {
  listTasks,
  getTaskStatus,
  getTaskDiff,
  getTaskOutput,
} from './coordinator/task-queries.js';
import {
  assertParentAdmission,
  stopChildren,
  resumeChildren,
  reserveChildRestart,
  countInFlightSubTasks,
} from './coordinator/admission.js';
import {
  cleanupLandedTaskResources,
  closeTask,
  removeCoordinatedTask,
  cleanupTask,
  detachChildren,
  detachChild,
  deregisterCoordinator,
} from './coordinator/teardown.js';
const REST_COORDINATOR_SENTINEL = 'api';

export class Coordinator implements CoordinatorInternals {
  // The fields are this class's own state. They are public only so the function
  // modules in ./coordinator/ can work on them through CoordinatorInternals;
  // nothing else should.
  tasks = new Map<string, CoordinatedTask>();
  tailBuffers = new Map<string, string>();
  idleResolvers = new Map<
    string,
    Array<(result: { reason: 'idle' | 'human_control' | 'exited' | 'removed' }) => void>
  >();
  subscribers = new Map<string, (encoded: string) => void>();
  decoders = new Map<string, TextDecoder>();
  controlMap = new Map<string, 'coordinator' | 'human'>();
  writingPromptTaskIds = new Set<string>();
  initialPromptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  initialPromptReadyTasks = new Set<string>();
  promptReadySeenAt = new Map<string, number>();
  queuedPromptFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
  coordinatorSpawnDefaults: { command: string; args: string[] } = {
    command: 'claude',
    args: [],
  };
  coordinatorAgentEnvFile: string | undefined;
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
  archiver: ChildArchiver = new ChildArchiver({
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
      const resolvers = this.idleResolvers.get(taskId);
      if (resolvers?.length) {
        for (const resolve of resolvers) resolve({ reason: 'human_control' });
        this.idleResolvers.delete(taskId);
      }
    }
    if (who === 'coordinator') {
      // A body typed before its Enter failed is queued work too: it still needs submitting.
      const hasQueuedWork = Boolean(task.initialPrompt) || this.prompts.hasQueuedWork(task);
      // Fire any idle resolvers queued while human had control
      const resolvers = this.idleResolvers.get(taskId);
      if (!hasQueuedWork && resolvers?.length) {
        for (const resolve of resolvers) resolve({ reason: 'idle' });
        this.idleResolvers.delete(taskId);
      }
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
    if (isAgentCreation) assertOrchestrationEnabled(this);
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
      if (isAgentCreation) assertOrchestrationEnabled(this);
      assertParentAdmission(this, coordinatorId, epoch);
      opts.nativeLaunchGuard?.();
      assertParentAdmission(this, coordinatorId, epoch);
    };
    const assertLaunch = async () => {
      if (isAgentCreation) assertOrchestrationEnabled(this);
      assertParentAdmission(this, coordinatorId, epoch);
      await opts.launchGuard?.();
      assertParentAdmission(this, coordinatorId, epoch);
    };
    await assertLaunch();

    // Hard concurrency gate — the preamble instructs the model to stay under
    // the limit, but instructions drift; this enforces it.
    const maxConcurrent = clampCoordinatorConcurrentTasks(
      coordinatorState.maxConcurrentSubTasks ?? DEFAULT_COORDINATOR_CONCURRENT_TASKS,
    );
    const inFlight =
      countInFlightSubTasks(this, coordinatorId) +
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
        notifyRenderer(this, IPC.MCP_TaskCleanupFailed, {
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
    if (!this.orchestrationEnabled) this.prompts.discardAutomatedPrompts(task);
    onInserted();
    this.tailBuffers.set(agentId, '');

    // Subscribe to PTY output for prompt detection
    const decoder = new TextDecoder();
    this.decoders.set(agentId, decoder);

    const outputCb = this.prompts.createAgentOutputMonitor(task);
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
      this.prompts.updateTailFromScrollback(task);
      this.prompts.scheduleInitialPromptDelivery(task, INITIAL_PROMPT_READY_DELAY_MS);

      // Notify renderer after backend startup begins. The backend owns delivery
      // of coordinated initial assignments so background sub-tasks start even
      // when their task panels are not mounted.
      // For renderer storage: only store the inner agent args (without docker wrapper).
      // TaskAITerminal re-wraps with the coordinator's current container name at respawn time
      // so stale container names don't get baked into persisted state.
      const notifyAgentArgs = agentArgs;
      notifyRenderer(this, IPC.MCP_TaskCreated, {
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
      cleanupTask(this, task.id).catch((cleanupErr) => {
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
      if (!this.orchestrationEnabled) this.prompts.discardAutomatedPrompts(existingTask);
      if (safeMcpConfigPath) existingTask.mcpConfigPath = safeMcpConfigPath;
      const mcpLaunchArgs = this.rewriteHydratedSubtaskMcpConfig(
        existingTask,
        opts.coordinatorTaskId,
        safeMcpConfigPath ?? existingTask.mcpConfigPath,
        opts.agentCommand,
      );
      // A renderer reload may have missed the publication event. Send the live
      // record back, rather than letting an older saved report replace it.
      notifyRenderer(this, IPC.MCP_TaskStateSync, {
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
    if (!this.orchestrationEnabled) this.prompts.discardAutomatedPrompts(task);
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
      const outputCb = this.prompts.createAgentOutputMonitor(task);
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
      clearAgentBuffers(this, agentId);
      this.subscribers.delete(agentId);
      this.prompts.clearPromptDeliveryState(task.id);
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
