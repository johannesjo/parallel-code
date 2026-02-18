import type { AgentDef, WorktreeStatus } from "../ipc/types";

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
}

export interface Agent {
  id: string;
  taskId: string;
  def: AgentDef;
  resumed: boolean;
  status: "running" | "exited";
  exitCode: number | null;
  signal: string | null;
  lastOutput: string[];
  generation: number;
}

export interface Task {
  id: string;
  name: string;
  projectId: string;
  branchName: string;
  worktreePath: string;
  agentIds: string[];
  shellAgentIds: string[];
  notes: string;
  lastPrompt: string;
  initialPrompt?: string;
  closingStatus?: "closing" | "removing" | "error";
  closingError?: string;
}

export interface PersistedTask {
  id: string;
  name: string;
  projectId: string;
  branchName: string;
  worktreePath: string;
  notes: string;
  lastPrompt: string;
  shellCount: number;
  agentDef: AgentDef | null;
}

export interface PersistedState {
  projects: Project[];
  lastProjectId: string | null;
  lastAgentId: string | null;
  taskOrder: string[];
  tasks: Record<string, PersistedTask>;
  activeTaskId: string | null;
  sidebarVisible: boolean;
  fontScales?: Record<string, number>;
  panelSizes?: Record<string, number>;
  globalScale?: number;
}

// Panel cell IDs. Shell terminals use "shell:0", "shell:1", etc.
// The shell toolbar is "shell-toolbar".
export type PanelId = string;

export interface PendingAction {
  type: "close" | "merge" | "push";
  taskId: string;
}

export interface AppStore {
  projects: Project[];
  lastProjectId: string | null;
  lastAgentId: string | null;
  taskOrder: string[];
  tasks: Record<string, Task>;
  agents: Record<string, Agent>;
  activeTaskId: string | null;
  activeAgentId: string | null;
  availableAgents: AgentDef[];
  showNewTaskDialog: boolean;
  sidebarVisible: boolean;
  fontScales: Record<string, number>;
  panelSizes: Record<string, number>;
  globalScale: number;
  taskGitStatus: Record<string, WorktreeStatus>;
  focusedPanel: Record<string, PanelId>;
  sidebarFocused: boolean;
  showHelpDialog: boolean;
  pendingAction: PendingAction | null;
}
