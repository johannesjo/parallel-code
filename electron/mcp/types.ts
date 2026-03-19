// Shared types for the MCP coordinating-agent system.

export interface OrchestratedTask {
  id: string;
  name: string;
  projectId: string;
  branchName: string;
  worktreePath: string;
  agentId: string;
  coordinatorTaskId: string;
  status: 'creating' | 'running' | 'idle' | 'exited' | 'error';
  exitCode: number | null;
  pendingPrompt?: string;
}

// --- MCP tool input schemas ---

export interface CreateTaskInput {
  name: string;
  prompt?: string;
  projectId?: string;
}

export type ListTasksInput = Record<string, never>;

export interface GetTaskStatusInput {
  taskId: string;
}

export interface SendPromptInput {
  taskId: string;
  prompt: string;
}

export interface WaitForIdleInput {
  taskId: string;
  timeoutMs?: number;
}

export interface GetTaskDiffInput {
  taskId: string;
}

export interface GetTaskOutputInput {
  taskId: string;
}

export interface MergeTaskInput {
  taskId: string;
  squash?: boolean;
  message?: string;
  cleanup?: boolean;
}

export interface CloseTaskInput {
  taskId: string;
}

// --- API request/response types ---

export interface ApiTaskSummary {
  id: string;
  name: string;
  branchName: string;
  status: string;
  coordinatorTaskId: string;
}

export interface ApiTaskDetail extends ApiTaskSummary {
  worktreePath: string;
  projectId: string;
  agentId: string;
  exitCode: number | null;
  pendingPrompt?: string;
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
}

export interface ApiMergeResult {
  mainBranch: string;
  linesAdded: number;
  linesRemoved: number;
}
