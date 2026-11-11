// Creating a sub-task: its worktree, MCP config, instruction preamble and agent.

import { randomUUID, randomBytes } from 'crypto';
import { unlink as fsUnlink } from 'fs/promises';
import { dirname } from 'path';
import { getSubTaskMcpConfigPath, writeSubTaskMcpConfig } from '../config.js';
import { buildMcpLaunchArgs, isAntigravityCommand } from '../agent-args.js';
import { writeAntigravityMcpConfig } from '../antigravity-config.js';
import { validateBranchName } from '../validation.js';
import {
  injectSubTaskPreamble,
  restoreSubTaskPreambleInjection,
  type InjectedSubTaskPreamble,
} from '../preamble.js';
import { execAsync, execStdout, currentBranch } from './child-git.js';
import { buildTaskMcpConfig, buildTaskMcpLaunchArgs } from './mcp-config.js';
import type { CoordinatorInternals } from './internals.js';
import { INITIAL_PROMPT_READY_DELAY_MS } from './prompts.js';
import { createTask as createBackendTask, deleteTask } from '../../ipc/tasks.js';
import { projectWorktreeDirs } from '../../ipc/project-worktree.js';
import {
  getSkipPermissionsArgs,
  stripPermissionBypassArgs,
} from '../../shared/skip-permissions.js';
import { spawnAgent, killAgent, subscribeToAgent } from '../../ipc/pty.js';
import {
  clampCoordinatorConcurrentTasks,
  DEFAULT_COORDINATOR_CONCURRENT_TASKS,
} from '../../shared/coordinator-limits.js';
import { getMainBranch } from '../../ipc/git.js';
import { resolveFreshStartPoint } from '../../ipc/git-start-point.js';
import { buildSubTaskPreamble } from '../sub-task-preamble.js';
import { warn as logWarn } from '../../log.js';
import type { CoordinatedTask, IntegrationPolicy, CoordinatorState } from '../types.js';
import { IPC } from '../../ipc/channels.js';
import { assertOrchestrationEnabled, notifyRenderer } from './internals.js';
import { startAgentOutputMonitor } from './agent-events.js';
import { assertParentAdmission, countInFlightSubTasks } from './admission.js';
import { cleanupTask } from './teardown.js';

const REST_COORDINATOR_SENTINEL = 'api';

/** What create_task needs to start a sub-task. */
export interface CreateTaskOptions {
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
}

export async function createTask(
  c: CoordinatorInternals,
  opts: CreateTaskOptions,
): Promise<CoordinatedTask> {
  const isAgentCreation = opts.coordinatorTaskId !== REST_COORDINATOR_SENTINEL;
  if (isAgentCreation) assertOrchestrationEnabled(c);
  const coordinatorId =
    opts.coordinatorTaskId !== REST_COORDINATOR_SENTINEL
      ? opts.coordinatorTaskId
      : c.defaultCoordinatorTaskId;
  if (!coordinatorId) {
    throw new Error(
      'No coordinator task registered yet. Ensure the coordinator task is fully initialized before calling create_task.',
    );
  }

  const coordinatorState = c.coordinators.get(coordinatorId);
  if (!coordinatorState) {
    throw new Error(
      `Unknown coordinator: ${coordinatorId}. Ensure the coordinator task is registered before creating sub-tasks.`,
    );
  }

  const epoch = coordinatorState.launchEpoch ?? 0;
  const assertNativeLaunch = () => {
    if (isAgentCreation) assertOrchestrationEnabled(c);
    assertParentAdmission(c, coordinatorId, epoch);
    opts.nativeLaunchGuard?.();
    assertParentAdmission(c, coordinatorId, epoch);
  };
  const assertLaunch = async () => {
    if (isAgentCreation) assertOrchestrationEnabled(c);
    assertParentAdmission(c, coordinatorId, epoch);
    await opts.launchGuard?.();
    assertParentAdmission(c, coordinatorId, epoch);
  };
  await assertLaunch();

  // Hard concurrency gate — the preamble instructs the model to stay under
  // the limit, but instructions drift; this enforces it.
  const maxConcurrent = clampCoordinatorConcurrentTasks(
    coordinatorState.maxConcurrentSubTasks ?? DEFAULT_COORDINATOR_CONCURRENT_TASKS,
  );
  const inFlight =
    countInFlightSubTasks(c, coordinatorId) + (c.pendingCreateCounts.get(coordinatorId) ?? 0);
  if (inFlight >= maxConcurrent) {
    throw new Error(
      `Sub-task concurrency limit reached (${inFlight}/${maxConcurrent} in flight). ` +
        'Use wait_for_signal_done, then review and merge or close finished sub-tasks before creating more.',
    );
  }
  c.pendingCreateCounts.set(coordinatorId, (c.pendingCreateCounts.get(coordinatorId) ?? 0) + 1);
  // The reservation is released as soon as the task is in this.tasks (where
  // countInFlightSubTasks sees it) — holding it longer would count the task
  // twice while its worktree/agent spawn finishes.
  let reserved = true;
  const releaseReservation = () => {
    if (!reserved) return;
    reserved = false;
    const pending = (c.pendingCreateCounts.get(coordinatorId) ?? 1) - 1;
    if (pending <= 0) c.pendingCreateCounts.delete(coordinatorId);
    else c.pendingCreateCounts.set(coordinatorId, pending);
  };
  try {
    return await createTaskUnchecked(c, opts, {
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

async function createTaskUnchecked(
  c: CoordinatorInternals,
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
  const notify = c.notify;
  if (!notify) throw new Error('No notifier set on coordinator');
  const root = opts.projectRoot ?? coordinatorState.projectRoot ?? c.projectRoot;
  const projId = opts.projectId ?? coordinatorState.projectId ?? c.projectId;
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
  // A snapshot pins the exact parent commit; otherwise start from fresh upstream.
  const startPoint = opts.snapshotCommit ?? (await resolveFreshStartPoint(root, baseBranch));
  await assertLaunch();
  // Keep the integration branch separate from the immutable creation snapshot.
  // Create worktree + branch via existing backend
  const { symlinkDirs, copyDirs } = projectWorktreeDirs(projId);
  const result = await createBackendTask(
    opts.name,
    root,
    symlinkDirs,
    'task',
    baseBranch,
    startPoint,
    copyDirs,
  );

  // Re-check after async gap — deregisterCoordinator may have run while we awaited.
  if (!c.coordinators.has(coordinatorId)) {
    // Best-effort cleanup of the worktree we just created.
    deleteTask({
      agentIds: [],
      branchName: result.branch_name,
      deleteBranch: true,
      projectRoot: root,
    }).catch((err) => {
      console.warn('Failed to clean up race-condition worktree:', err);
      notifyRenderer(c, IPC.MCP_TaskCleanupFailed, {
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
    dockerContainerName: c.coordinators.get(coordinatorId)?.dockerContainerName ?? null,
  };

  c.tasks.set(task.id, task);
  if (!c.orchestrationEnabled) c.prompts.discardAutomatedPrompts(task);
  onInserted();

  // Subscribe to PTY output for prompt detection
  const outputCb = startAgentOutputMonitor(c, task);

  // closeTask/removeCoordinatedTask can delete the task while we are awaiting;
  // continuing would spawn into a deleted worktree and announce a dead task.
  const assertStillPresent = () => {
    if (c.tasks.get(task.id) !== task || c.closingTaskIds.has(task.id)) {
      throw new Error(`Task ${task.id} was closed during creation`);
    }
  };

  const agentCommand = opts.agentCommand ?? coordinatorState.spawnDefaults.command;
  const dockerContainerName =
    c.coordinators.get(task.coordinatorTaskId)?.dockerContainerName ?? null;

  let preambleInjection: InjectedSubTaskPreamble | undefined;
  let subTaskMcpConfigPath: string | undefined;
  try {
    preambleInjection = await injectSubTaskPreamble({
      worktreePath: result.worktree_path,
      agentCommand,
      queue: c.preambleWriteQueue,
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
      const { mcpConfig } = buildTaskMcpConfig(
        task,
        { serverPath, serverUrl, subtaskToken, doneToken },
        c.sessionMcpProvider,
      );
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
              dockerReadOnlyMounts: getDockerMcpMounts(c, task.id),
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
      killAgentBestEffort(agentId);
      throw err;
    }

    // Subscribe for output monitoring
    subscribeToAgent(agentId, outputCb);
    task.status = 'running';

    // Check scrollback in case the prompt was emitted before we subscribed.
    c.prompts.updateTailFromScrollback(task);
    c.prompts.scheduleInitialPromptDelivery(task, INITIAL_PROMPT_READY_DELAY_MS);

    // Notify renderer after backend startup begins. The backend owns delivery
    // of coordinated initial assignments so background sub-tasks start even
    // when their task panels are not mounted.
    // For renderer storage: only store the inner agent args (without docker wrapper).
    // TaskAITerminal re-wraps with the coordinator's current container name at respawn time
    // so stale container names don't get baked into persisted state.
    const notifyAgentArgs = agentArgs;
    notifyRenderer(c, IPC.MCP_TaskCreated, {
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
    cleanupTask(c, task.id).catch((cleanupErr) => {
      logWarn('coordinator.create_task', 'cleanup after failed creation failed', {
        taskId: task.id,
        err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    });
    throw err;
  }
}

function killAgentBestEffort(agentId: string): void {
  try {
    killAgent(agentId);
  } catch (err) {
    logWarn('coordinator.kill_agent', 'kill failed (agent may already be gone)', {
      agentId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Dirs a Docker sub-task container must mount to start the coordinator's MCP
 * server: its copy of mcp-server.cjs and the per-sub-task config sit together
 * in the coordinator's `.parallel-code/`, wherever that worktree lives.
 */
export function getDockerMcpMounts(c: CoordinatorInternals, taskId: string): string[] | undefined {
  const task = c.tasks.get(taskId);
  const state = task && c.coordinators.get(task.coordinatorTaskId);
  if (!state?.dockerContainerName || !state.mcpServerInfo) return undefined;
  return [dirname(state.mcpServerInfo.serverPath)];
}
