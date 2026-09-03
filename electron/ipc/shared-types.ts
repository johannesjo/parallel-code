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

// --- Document workspaces ---

/** Current state of the canonical document in the project checkout. */
export interface DocumentSnapshot {
  content: string;
  /** HEAD sha of the canonical branch; null in an empty repository. */
  headSha: string | null;
  /** Checked-out branch name; null when HEAD is detached. */
  branch: string | null;
  /** True when the working tree has uncommitted changes (outside `.worktrees/`). */
  dirty: boolean;
  /** True when the document file is missing from the checkout. */
  missing: boolean;
}

/** What part of the document a run is allowed to change. Lines are 1-based and
 *  inclusive at the base commit; a whole-document scope has `wholeDocument`. */
export interface DocumentScope {
  path: string;
  wholeDocument: boolean;
  startLine: number;
  endLine: number;
  /** Exact quoted text of the selected passage (block-aligned). */
  quote: string;
  /** Nearest heading above the selection, when any. */
  heading?: string;
}

export interface DocumentRationale {
  summary: string;
  changes: string[];
  assumptions: string[];
  questions: string[];
  warnings: string[];
}

export type DocumentCandidateStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface DocumentCandidateRecord {
  id: string;
  /** Neutral label used when the comparison hides agent identity ("A", "B", …). */
  label: string;
  agentId: string;
  agentName: string;
  /** The project's warm main session rather than a throwaway alternate. */
  isMain: boolean;
  branch: string;
  worktreePath: string;
  status: DocumentCandidateStatus;
  /** Proposal commit on `branch`; null while running or when nothing changed. */
  commitSha: string | null;
  /** Provider session id, when the CLI reported one (used to resume the main session). */
  sessionId?: string;
  exitCode?: number | null;
  startedAt: string;
  finishedAt?: string;
  rationale?: DocumentRationale;
  /** Final assistant text, kept when it does not parse as a rationale. */
  resultText?: string;
  /** Files the agent touched outside the scoped document. They are reverted
   *  before the proposal commit and listed here so the reviewer sees it. */
  outOfScopeFiles?: string[];
  /** Hunks inside the document that fall outside the selected passage. */
  outOfScopeHunks?: number;
  noChanges?: boolean;
  error?: string;
  /** Reviewer's note on this candidate from the compare view. */
  note?: string;
}

export type DocumentRunStatus = 'running' | 'finished' | 'accepted' | 'rejected' | 'stale';

/** Persisted under `.parallel/runs/<id>.json` inside the document project. */
export interface DocumentRunRecord {
  /** Format version of this record. */
  version: 1;
  id: string;
  documentPath: string;
  createdAt: string;
  instruction: string;
  scope: DocumentScope;
  baseSha: string;
  status: DocumentRunStatus;
  candidates: DocumentCandidateRecord[];
  acceptedCandidateId?: string;
  finishedAt?: string;
}

/** Streamed from the main process while a run is in flight. */
export type DocumentRunEvent =
  | { type: 'log'; runId: string; candidateId: string; text: string }
  | { type: 'candidate'; runId: string; candidate: DocumentCandidateRecord }
  | { type: 'run'; run: DocumentRunRecord };

export interface DocumentCandidateSpec {
  id: string;
  label: string;
  agentId: string;
  agentName: string;
  command: string;
  isMain: boolean;
  /** Provider session to resume for the main candidate. */
  sessionId?: string;
  /** Sha the resumed session last saw; the prompt carries the diff since then. */
  sessionLastSha?: string;
  /** Per-agent env file, when configured. */
  envFile?: string;
}

export interface DocumentHistoryEntry {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  /** Unix seconds. */
  timestamp: number;
  /** `Parallel-*` trailers, keys without the prefix (e.g. `Agent`, `Run`). */
  trailers: Record<string, string>;
  /** True when no agent trailer is present: a manual commit. */
  manual: boolean;
}
