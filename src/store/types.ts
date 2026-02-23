import type { AgentDef, WorktreeStatus } from '../ipc/types';
import type { TerminalFont } from '../lib/fonts';
import type { LookPreset } from '../lib/look';

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
  defaultDirectMode?: boolean; // default false if unset
  terminalBookmarks?: TerminalBookmark[];
}

export interface Agent {
  id: string;
  taskId: string;
  def: AgentDef;
  resumed: boolean;
  status: 'running' | 'exited';
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
  initialPrompt?: string; // auto-sends when agent is ready
  savedInitialPrompt?: string;
  prefillPrompt?: string; // fills prompt input without sending
  closingStatus?: 'closing' | 'removing' | 'error';
  closingError?: string;
  directMode?: boolean;
  skipPermissions?: boolean;
  githubUrl?: string;
}

export interface Terminal {
  id: string;
  name: string;
  agentId: string;
  closingStatus?: 'closing' | 'removing';
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
  skipPermissions?: boolean;
  githubUrl?: string;
  savedInitialPrompt?: string;
}

export interface PersistedTerminal {
  id: string;
  name: string;
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
  terminals?: Record<string, PersistedTerminal>;
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
  inactiveColumnOpacity?: number;
}

// Panel cell IDs. Shell terminals use "shell:0", "shell:1", etc.
// The shell toolbar is "shell-toolbar".
export type PanelId = string;

export interface PendingAction {
  type: 'close' | 'merge' | 'push';
  taskId: string;
}

export interface RemoteAccess {
  enabled: boolean;
  token: string | null;
  port: number;
  url: string | null;
  wifiUrl: string | null;
  tailscaleUrl: string | null;
  connectedClients: number;
}

export interface AppStore {
  projects: Project[];
  lastProjectId: string | null;
  lastAgentId: string | null;
  taskOrder: string[];
  tasks: Record<string, Task>;
  terminals: Record<string, Terminal>;
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
  placeholderFocused: boolean;
  placeholderFocusedButton: 'add-task' | 'add-terminal';
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
  inactiveColumnOpacity: number;
  newTaskDropUrl: string | null;
  remoteAccess: RemoteAccess;
}
