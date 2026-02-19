export type PtyOutput =
  | { type: "Data"; data: string }  // base64-encoded
  | { type: "Exit"; data: { exit_code: number | null; signal: string | null; last_output: string[] } };

export interface AgentDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  resume_args?: string[];
  description: string;
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
  status: "Active" | "Closed";
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
