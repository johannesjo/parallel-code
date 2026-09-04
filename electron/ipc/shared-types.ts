export type PtyOutput =
  | { type: 'Data'; data: string } // base64-encoded
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
  message: string;
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
  overall: PrChecksOverall;
  /** Additive review metadata from GitHub. Absent for older senders and null
   *  when GitHub has no supported review decision. */
  isDraft?: boolean;
  reviewDecision?: PrReviewDecision | null;
  passing: number;
  pending: number;
  failing: number;
  checks: PrCheckRun[];
  checkedAt: string;
  /** True when the main process has stopped watching this task (PR merged or
   *  closed). The renderer should drop its bookkeeping so a later restart of
   *  the watcher (e.g. PR reopened) goes through cleanly. */
  cleared: boolean;
}

export interface BranchPrDetectionResult {
  url: string | null;
  unavailable?: 'missing' | 'auth';
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

export type UsageResult =
  | {
      status: 'ok';
      fiveHour: UsageWindow | null;
      sevenDay: UsageWindow | null;
      fetchedAt: number;
    }
  /** No subscription login to read — the status bar hides itself. */
  | { status: 'unavailable'; reason: string }
  /** Transient failure — the renderer keeps its last good snapshot. */
  | { status: 'error'; message: string };
