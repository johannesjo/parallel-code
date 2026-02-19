import type { AgentDef, WorktreeStatus } from "../ipc/types";
import type { TerminalFont } from "../lib/fonts";
import type { LookPreset } from "../lib/look";

export interface TerminalBookmark {
  id: string;
  command: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
  branchPrefix?: string; // default "task" if unset
  deleteBranchOnClose?: boolean; // default true if unset
  terminalBookmarks?: TerminalBookmark[];
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
  directMode?: boolean;
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
  directMode?: boolean;
}

export interface PersistedWindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
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
  completedTaskDate?: string;
  completedTaskCount?: number;
  mergedLinesAdded?: number;
  mergedLinesRemoved?: number;
  terminalFont?: TerminalFont;
  themePreset?: LookPreset;
  windowState?: PersistedWindowState;
  autoTrustFolders?: boolean;
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
  sidebarFocusedProjectId: string | null;
  sidebarFocusedTaskId: string | null;
  showHelpDialog: boolean;
  showSettingsDialog: boolean;
  pendingAction: PendingAction | null;
  notification: string | null;
  completedTaskDate: string;
  completedTaskCount: number;
  mergedLinesAdded: number;
  mergedLinesRemoved: number;
  terminalFont: TerminalFont;
  themePreset: LookPreset;
  windowState: PersistedWindowState | null;
  autoTrustFolders: boolean;
}
