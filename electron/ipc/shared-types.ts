import type { TriageKind, TriageSort } from '../shared/github-triage.js';

/** Persisted ownership fingerprint for an auto-discovered MCP configuration. */
export interface AutoDiscoveredMcpConfigState {
  path: string;
  writtenParallelCodeFingerprint: string;
}

export type PtyOutput =
  | { type: 'Data'; data: Uint8Array } // raw terminal bytes
  | {
      type: 'Exit';
      data: { exit_code: number | null; signal: string | null; last_output: string[] };
    };

export interface AgentDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  resume_args: string[];
  skip_permissions_args: string[];
  description: string;
  available?: boolean;
  /** Per-agent override for the stability-check delay (ms) used before auto-sending
   *  the initial prompt.  Agents with multi-step init dialogs need a longer wait. */
  prompt_ready_delay_ms?: number;
  /** CLI flag used to pass an MCP config path to this agent. Omit when unsupported. */
  mcp_config_flag?: string;
}

export interface CreateTaskResult {
  id: string;
  branch_name: string;
  worktree_path: string;
}

export interface SymlinkCandidate {
  name: string;
  isDefault: boolean;
}

/** Legacy name used by renderer IPC consumers. */
export type GitIgnoredEntry = SymlinkCandidate;

export interface ChangedFile {
  path: string;
  /** Original path when Git reports a rename or copy. */
  previous_path?: string;
  lines_added: number;
  lines_removed: number;
  status: string;
  committed: boolean;
}

export interface CoverageMetricSummary {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

export interface CoverageFileSummary {
  path: string;
  lines: CoverageMetricSummary;
  statements: CoverageMetricSummary;
  functions: CoverageMetricSummary;
  branches: CoverageMetricSummary;
}

export interface CoverageSummary {
  format: 'istanbul-summary' | 'lcov';
  generatedAt: string;
  reportPath: string;
  totals: Omit<CoverageFileSummary, 'path'>;
  files: Record<string, CoverageFileSummary>;
}

export interface WorktreeStatus {
  has_committed_changes: boolean;
  has_uncommitted_changes: boolean;
  current_branch: string | null;
  /** Resolved base branch (explicit or detected main); null when the worktree
   *  is unreadable. */
  base_branch: string | null;
  /** HEAD commit sha; lets consumers tell whether a verification run still
   *  describes the current tree. Absent from older senders, null when unreadable. */
  head_sha?: string | null;
}

export type VerificationRunStatus =
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'error';

/** One execution of a project's verify command inside a task worktree. */
export interface VerificationRun {
  command: string;
  status: VerificationRunStatus;
  exitCode: number | null;
  /** HEAD sha when the run started; null outside a git checkout. */
  headSha: string | null;
  /** True when the worktree had uncommitted changes when the run started. */
  dirty: boolean;
  /** HEAD and dirty state once the command ended. A difference from the start
   *  means the code changed during the run, so the result covers neither. */
  headShaAfter?: string | null;
  dirtyAfter?: boolean;
  startedAt: string;
  finishedAt: string | null;
  /** Bounded tail of combined stdout and stderr, ANSI stripped. */
  outputTail: string;
  /** Human-readable reason for `error`, `timed_out` and `cancelled`. */
  message?: string;
}

export interface ImportableWorktree {
  path: string;
  branch_name: string;
  has_committed_changes: boolean;
  has_uncommitted_changes: boolean;
}

export interface MergeStatus {
  main_ahead_count: number;
  conflicting_files: string[];
  base_branch: string;
}

export interface MergeResult {
  main_branch: string;
  lines_added: number;
  lines_removed: number;
}

export interface FileDiffResult {
  diff: string;
  oldContent: string;
  newContent: string;
}

export interface CommitInfo {
  hash: string;
  /** Subject line. */
  message: string;
  /** Message after the subject; only filled when requested with `withBody`. */
  body?: string;
}

export type PrCheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
export type PrChecksOverall = 'pending' | 'success' | 'failure' | 'none';
export type PrReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';

export interface PrCheckRun {
  name: string;
  bucket: PrCheckBucket;
}

export interface PrChecksUpdatePayload {
  taskId: string;
  prUrl?: string;
  /** Actual GitHub merge time, not the time the watcher noticed it. */
  mergedAt?: string;
  overall: PrChecksOverall;
  /** Additive review metadata from GitHub. Absent for older senders and null
   *  when GitHub has no supported review decision. */
  isDraft?: boolean;
  reviewDecision?: PrReviewDecision | null;
  mergeable?: PrMergeable;
  passing: number;
  pending: number;
  failing: number;
  checks: PrCheckRun[];
  checkedAt: string;
  /** True when the main process has stopped watching this task (PR merged or
   *  closed). The renderer should drop its bookkeeping so a later restart of
   *  the watcher (e.g. PR reopened) goes through cleanly. */
  cleared: boolean;
  /** Set with `cleared` when the PR was merged rather than closed. Absent for
   *  older senders. */
  merged?: boolean;
}

export interface BranchPrDetectionResult {
  url: string | null;
  unavailable?: 'missing' | 'auth';
}

/** An open issue or pull request offered as a starting point for a task. */
export interface GitHubWorkItem {
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  url: string;
  author: string;
  updatedAt: string;
  labels: string[];
  /** PR-only fields. */
  isDraft?: boolean;
  baseRefName?: string;
  isCrossRepository?: boolean;
}

export interface GitHubIssueDetails {
  number: number;
  title: string;
  body: string;
  url: string;
}

/** Repository issue browser data; full bodies are kept out of task prompts. */
export interface GitHubIssueSummary extends GitHubIssueDetails {
  kind: 'issue' | 'pr';
  baseRefName?: string;
  isCrossRepository?: boolean;
  issueType?: string;
  isDraft: boolean;
  commentCount: number;
  reactionCount: number;
  createdAt: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  updatedAt: string;
  labels: string[];
  assignees: string[];
}

export interface GitHubIssueQuery {
  kind: TriageKind;
  sort: TriageSort;
  author: string;
  search: string;
  state: 'open' | 'closed' | 'all';
  label: string;
  assignee: string;
  page: number;
}

export interface GitHubIssuePage {
  labels: string[];
  repository: string;
  items: GitHubIssueSummary[];
  total: number;
  hasMore: boolean;
  limited: boolean;
}

export interface GitHubIssueActivity {
  id: string;
  author: string;
  createdAt: string;
  event: string;
  body: string;
}

export interface GitHubIssueActivityPage {
  items: GitHubIssueActivity[];
  hasMore: boolean;
}

export type GitHubIssueChange =
  | { field: 'labels' | 'assignees'; values: string[] }
  | { field: 'state'; value: 'open' | 'closed'; reason?: 'completed' | 'not_planned' };

export interface CreatePrTaskResult extends CreateTaskResult {
  pr_url: string;
  base_branch: string;
}

export type PrMergeMethod = 'squash' | 'merge' | 'rebase';
export type PrMergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

export interface PullRequestDetails {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  mergeable: PrMergeable;
  /** GitHub's mergeStateStatus, e.g. CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE. */
  mergeStateStatus: string;
  baseRefName: string;
  headRefName: string;
  /** Head commit; merging is pinned to it so later pushes are not merged unseen. */
  headRefOid: string;
  /** Repo-allowed merge methods, the viewer's default first. */
  mergeMethods: PrMergeMethod[];
}

export interface PrFailedCheck {
  name: string;
  url: string | null;
  /** Cleaned tail of the GitHub Actions job log, when one was available. */
  logTail: string | null;
}

export interface PrReviewThread {
  path: string;
  line: number | null;
  isOutdated: boolean;
  comments: { author: string; body: string }[];
}

export interface PrReviewFeedback {
  /** Non-empty summary bodies of submitted reviews. */
  reviews: { author: string; state: string; body: string }[];
  /** Unresolved inline review threads. */
  threads: PrReviewThread[];
  /** GitHub has more threads than were fetched. */
  truncated: boolean;
}

export interface EslintQualityFinding {
  id: string;
  source: 'eslint';
  ruleId: string;
  category: 'maintainability';
  severity: 'error' | 'warning';
  location: {
    filePath: string;
    startLine: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
  };
  explanation: string;
}

export type EslintQualityResult =
  | { status: 'available'; findings: EslintQualityFinding[] }
  | { status: 'not-applicable' }
  | { status: 'unavailable'; message: string };

export interface StepEntry {
  summary: string;
  detail?: string;
  next?: string;
  status: 'starting' | 'investigating' | 'implementing' | 'testing' | 'awaiting_review' | 'done';
  files_touched?: string[];
  /** Optional sub-agent identifier — short label (e.g. "auth-worker") so the UI can
   *  group entries written on behalf of delegated work. Omit for the top-level agent. */
  agent_id?: string;
  timestamp: string;
}

/** Agents whose subscription rate limits the app can read. */
export type UsageProvider = 'claude' | 'codex';

export interface UsageWindow {
  /** Percent of the window consumed, 0–100. */
  usedPercent: number;
  /** Unix ms when the window resets, null when the API omits it. */
  resetsAt: number | null;
}

export interface CreditUsage {
  /** Amount used in standard currency units (e.g. 2.12 for $2.12). */
  used: number;
  /** Spending limit in standard currency units, null if unlimited or not set. */
  limit: number | null;
  /** Currency code, e.g. "USD". */
  currency: string;
  /** Percent of limit used (0–100), null if limit is not set. */
  usedPercent: number | null;
}

export type UsageResult =
  | {
      status: 'ok';
      fiveHour: UsageWindow | null;
      sevenDay: UsageWindow | null;
      creditUsage?: CreditUsage | null;
      fetchedAt: number;
    }
  /** No subscription login to read — the status bar hides itself. */
  | { status: 'unavailable'; reason: string }
  /** Transient failure — the renderer keeps its last good snapshot. */
  | { status: 'error'; message: string };

/** One OS process in the resources panel. */
export interface ResourceProcess {
  pid: number;
  name: string;
  /** Percent of one CPU core; a busy multi-threaded process can exceed 100. */
  cpuPercent: number;
  /** Resident memory. */
  memoryBytes: number;
}

/** A PTY's process tree, the app itself, or the app's other subprocesses. */
export interface ResourceGroup {
  kind: 'agent' | 'shell' | 'app' | 'other';
  agentId: string | null;
  taskId: string | null;
  cpuPercent: number;
  memoryBytes: number;
  processes: ResourceProcess[];
}

export interface ResourceSnapshot {
  groups: ResourceGroup[];
  cpuCount: number;
  totalMemoryBytes: number;
  sampledAt: number;
}

export type UpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  /** Version this app is currently running. */
  currentVersion: string;
  /** Version offered by the latest check, when newer than `currentVersion`. */
  latestVersion: string | null;
  /** 0–100 while `phase` is `downloading`. */
  downloadPercent: number;
  /** Human-readable message when `phase` is `error`. */
  error: string | null;
}
