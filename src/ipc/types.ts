export type PtyOutput =
  | { type: "Data"; data: number[] }
  | { type: "Exit"; data: number | null };

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
}
