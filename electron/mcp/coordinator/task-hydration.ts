// Restoring a persisted sub-task after an app restart, and rewriting its MCP
// config when its agent is relaunched.

import { isAllowedSubTaskMcpConfigPath } from '../config.js';
import { rewriteSubtaskMcpConfig } from './mcp-config.js';
import type { CoordinatorInternals } from './internals.js';
import { subscribeToAgent } from '../../ipc/pty.js';
import type {
  CoordinatedTask,
  IntegrationPolicy,
  LandingState,
  SubtaskVerification,
} from '../types.js';
import { IPC } from '../../ipc/channels.js';
import { parseCloseSuggestion, type CloseSuggestion } from '../../shared/close-suggestion.js';
import { parseCompletionRecord, type CompletionRecord } from '../../shared/completion-report.js';
import { notifyRenderer } from './internals.js';
import { clearAgentBuffers, startAgentOutputMonitor } from './agent-events.js';

/** A persisted sub-task, as the app restores it after a restart. */
export interface HydrateTaskOptions {
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
}

export function hydrateTask(
  c: CoordinatorInternals,
  opts: HydrateTaskOptions,
): { mcpLaunchArgs?: string[] } {
  const coordinatorState = c.coordinators.get(opts.coordinatorTaskId);
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

  const existingTask = c.tasks.get(opts.id);
  if (existingTask) {
    if (!c.orchestrationEnabled) c.prompts.discardAutomatedPrompts(existingTask);
    if (safeMcpConfigPath) existingTask.mcpConfigPath = safeMcpConfigPath;
    const mcpLaunchArgs = rewriteHydratedSubtaskMcpConfig(
      c,
      existingTask,
      opts.coordinatorTaskId,
      safeMcpConfigPath ?? existingTask.mcpConfigPath,
      opts.agentCommand,
    );
    // A renderer reload may have missed the publication event. Send the live
    // record back, rather than letting an older saved report replace it.
    notifyRenderer(c, IPC.MCP_TaskStateSync, {
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
  c.tasks.set(task.id, task);
  if (!c.orchestrationEnabled) c.prompts.discardAutomatedPrompts(task);
  if (opts.landedMetadata) {
    c.landing.seedLandedOrder(opts.coordinatorTaskId, opts.landedMetadata.landedOrder);
  }
  if (opts.controlledBy === 'human' && (!task.initialPrompt || task.assignedPromptDelivered)) {
    c.controlMap.set(task.id, 'human');
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
    const mcpLaunchArgs = rewriteHydratedSubtaskMcpConfig(
      c,
      task,
      opts.coordinatorTaskId,
      safeMcpConfigPath,
      opts.agentCommand,
    );

    const outputCb = startAgentOutputMonitor(c, task);
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
    clearAgentBuffers(c, agentId);
    c.subscribers.delete(agentId);
    c.prompts.clearPromptDeliveryState(task.id);
    c.tasks.delete(task.id);
    throw err;
  }
}

/** Called after IPC installs the new launch identity, before replacing its PTY. */
export function refreshSessionMcp(
  c: CoordinatorInternals,
  taskId: string,
  agentCommand: string,
): { mcpLaunchArgs?: string[]; mcpConfigPath?: string } {
  const task = c.tasks.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return {
    mcpLaunchArgs: rewriteHydratedSubtaskMcpConfig(
      c,
      task,
      task.coordinatorTaskId,
      task.mcpConfigPath,
      agentCommand,
    ),
    mcpConfigPath: task.mcpConfigPath,
  };
}

function rewriteHydratedSubtaskMcpConfig(
  c: CoordinatorInternals,
  task: CoordinatedTask,
  coordinatorTaskId: string,
  mcpConfigPath: string | undefined,
  agentCommand: string | undefined,
): string[] | undefined {
  return rewriteSubtaskMcpConfig(
    task,
    c.coordinators.get(coordinatorTaskId),
    c.sessionMcpProvider,
    mcpConfigPath,
    agentCommand,
  );
}
