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
}

export interface CreateTaskResult {
  id: string;
  branch_name: string;
  worktree_path: string;
}

export interface TaskInfo {
  id: string;
  name: string;
  branch_name: string;
  worktree_path: string;
  agent_ids: string[];
  status: 'Active' | 'Closed';
}

export interface ChangedFile {
  path: string;
  lines_added: number;
  lines_removed: number;
  status: string;
  committed: boolean;
}

export interface WorktreeStatus {
  has_committed_changes: boolean;
  has_uncommitted_changes: boolean;
  current_branch: string | null;
}

export interface MergeStatus {
  main_ahead_count: number;
  conflicting_files: string[];
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
