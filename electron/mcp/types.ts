import type { VerificationRun } from '../ipc/shared-types.js';

// Shared types for the MCP coordinating-agent system.

export interface CoordinatedTask {
  id: string;
  name: string;
  projectId: string;
  projectRoot: string; // snapshot at creation; prevents stale root if setDefaultProject is called for another project later
  branchName: string;
  baseBranch?: string; // branch the worktree was forked from; merge target for merge_task
  worktreePath: string;
  agentId: string;
  coordinatorTaskId: string;
  status: 'creating' | 'running' | 'idle' | 'exited' | 'error';
  exitCode: number | null;
  pendingPrompts?: string[];
  initialPrompt?: string;
  automationWriteInFlight?: boolean;
  mcpConfigPath?: string; // path to per-task tmp config, deleted on cleanup
  doneToken?: string; // per-task token; only the owning sub-task may call /done
  preambleFileExistedBefore?: boolean; // true if the preamble file existed before injection (even if empty)
  signalDoneAt?: Date; // set when sub-task explicitly calls signal_done
  signalDoneConsumed?: boolean; // true after wait_for_signal_done returns this task's signal
  verification?: SubtaskVerification;
  /** Result of the app running the project's verify command before landing. */
  verificationRun?: VerificationRun;
  landingState?: LandingState;
  landingReason?: string;
  landingSummary?: string;
  landedMetadata?: LandedMetadata;
  // Coordinator notification lifecycle flags
  assignedPromptDelivered?: boolean;
  // Ignore the prompt that was already visible when a coordinator-delivered prompt was sent.
  suppressIdleUntil?: number;
  lastPromptEchoText?: string;
  reviewNotificationQueued?: boolean;
  /** Coordinator Docker container name. Set when the coordinator runs in Docker mode.
   *  Sub-tasks each get their own `docker run` container; this is not used for spawning
   *  sub-tasks but helps identify whether this task is part of a Docker coordinator. */
  dockerContainerName?: string | null;
}

export interface WaitForSignalDoneResult {
  taskId?: string;
  name?: string;
  status?: string;
  signalDoneAt?: string; // ISO timestamp
  remaining: number; // unconsumed signals + still-running tasks for this coordinator
  timedOut?: true; // set when no signal arrived before the timeout
}

export interface PendingNotification {
  id: string;
  taskId: string;
  taskName: string;
  branchName: string;
  state: 'idle' | 'exited' | 'landed';
  exitCode: number | null;
  completedAt: Date;
}

export type CoordinatorLifecycle = 'starting' | 'ready' | 'closing' | 'closed';

export interface CoordinatorState {
  taskId: string;
  lifecycle: CoordinatorLifecycle;
  projectId: string;
  projectRoot: string;
  branchName?: string;
  worktreePath?: string;
  /** Docker container name for this coordinator (used for identification/cleanup, not for spawning sub-tasks). */
  dockerContainerName?: string | null;
  /** Docker image used by this coordinator. Sub-tasks spawn their own containers using this same image. */
  dockerImage?: string | null;
  /** Per-coordinator MCP server info; set after the remote server starts. */
  mcpServerInfo: {
    serverUrl: string;
    token: string;
    subtaskToken: string;
    serverPath: string;
  } | null;
  /** Per-coordinator agent spawn defaults; set when the coordinator registers. */
  spawnDefaults: { command: string; args: string[] };
  /** Env file the coordinator's own agent uses; sub-tasks inherit it so they
   *  get the same credentials. Undefined when no env file is configured. */
  agentEnvFile?: string;
  pendingNotifications: PendingNotification[];
  /** batchId → array of pendingNotification IDs included in that batch */
  stagedBatches: Map<string, string[]>;
  /** Bounded to last 64 to prevent unbounded growth */
  ackedBatchIds: string[];
  restageTimer: ReturnType<typeof setTimeout> | null;
  /** Whether to pass skipPermissions to sub-tasks created by this coordinator. */
  propagateSkipPermissions: boolean;
  /** Enforced ceiling on concurrently in-flight sub-tasks (clamped; default applies when unset). */
  maxConcurrentSubTasks?: number;
  /** Project verify command, run in a sub-task's worktree before it is merged. */
  verifyCommand?: string;
  /** Path to the .mcp.json file written for this coordinator. */
  mcpJsonPath: string;
  /** True if Parallel Code created .mcp.json from scratch; false if it was pre-existing. */
  createdMcpJson: boolean;
  /** Previous value of mcpServers["parallel-code"] before this coordinator wrote its entry, if any. */
  previousMcpParallelCode?: unknown;
  /** The value this coordinator wrote into mcpServers["parallel-code"]; used to detect concurrent edits on deregister. */
  writtenMcpParallelCode?: unknown;
}

export interface SubtaskVerificationCheck {
  name: string;
  command: string;
  result: 'passed' | 'blocked' | 'failed';
  reason?: string;
}

export interface SubtaskVerification {
  checks: SubtaskVerificationCheck[];
}

export type LandingState =
  | 'landing_escalated'
  | 'landing_failed'
  | 'landed_pending_review'
  | 'landed_cleanup_failed'
  | 'reviewed';

export interface LandedMetadata {
  taskId: string;
  taskName: string;
  coordinatorTaskId: string;
  targetBranch: string;
  landedCommit: string;
  landedAt: string;
  landedOrder: number;
  summary?: string;
  verification: SubtaskVerification;
}

// --- MCP tool input schemas ---

export interface LandSelfInput {
  verification: SubtaskVerification;
  summary?: string;
}

// --- API request/response types ---

export interface ApiTaskSummary {
  id: string;
  name: string;
  branchName: string;
  status: string;
  coordinatorTaskId: string;
  signalDoneAt?: string; // ISO timestamp, set when sub-task called signal_done
  verification?: SubtaskVerification;
  landingState?: LandingState;
  landingReason?: string;
  landingSummary?: string;
  landedMetadata?: LandedMetadata;
}

export interface ApiTaskDetail extends ApiTaskSummary {
  worktreePath: string;
  projectId: string;
  agentId: string;
  exitCode: number | null;
  pendingPrompt?: string;
  pendingPrompts?: string[];
  pendingPromptCount?: number;
}

export interface ApiDiffResult {
  files: Array<{
    path: string;
    lines_added: number;
    lines_removed: number;
    status: string;
    committed: boolean;
  }>;
  diff: string;
  truncated?: boolean;
  originalSizeBytes?: number;
}

export interface ApiMergeResult {
  mainBranch: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface ApiReviewAndMergeResult {
  diff: ApiDiffResult;
  merge: ApiMergeResult;
}

export interface ApiLandSelfResult extends ApiMergeResult {
  landingState: LandingState;
  landedMetadata: LandedMetadata;
}
