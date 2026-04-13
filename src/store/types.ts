import type { AgentDef, StepEntry, WorktreeStatus } from '../ipc/types';
import type { DockerSource } from '../lib/docker';
import type { LookPreset } from '../lib/look';
import type { KeyBinding } from '../lib/keybindings';

/** A user override for a binding: partial key/modifiers to apply, or null to unbind. */
export type KeybindingOverride = Partial<Pick<KeyBinding, 'key' | 'modifiers'>> | null;

export type GitIsolationMode = 'worktree' | 'direct' | 'none';

export type TaskViewportVisibility = 'visible' | 'offscreen-left' | 'offscreen-right';

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
  defaultGitIsolation?: GitIsolationMode;
  defaultBaseBranch?: string;
  terminalBookmarks?: TerminalBookmark[];
  isGitRepo?: boolean; // undefined treated as true for backward compat
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
  gitIsolation: GitIsolationMode;
  baseBranch?: string;
  externalWorktree?: boolean;
  skipPermissions?: boolean;
  dockerMode?: boolean;
  dockerSource?: DockerSource;
  dockerImage?: string;
  githubUrl?: string;
  collapsed?: boolean;
  savedAgentDef?: AgentDef;
  planContent?: string;
  planFileName?: string;
  stepsEnabled?: boolean;
  stepsContent?: StepEntry[];
  lastInputAt?: string;
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
  gitIsolation: GitIsolationMode;
  baseBranch?: string;
  externalWorktree?: boolean;
  skipPermissions?: boolean;
  dockerMode?: boolean;
  dockerSource?: DockerSource;
  dockerImage?: string;
  githubUrl?: string;
  savedInitialPrompt?: string;
  collapsed?: boolean;
  planFileName?: string;
  stepsEnabled?: boolean;
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
  collapsedTaskOrder?: string[];
  tasks: Record<string, PersistedTask>;
  terminals?: Record<string, PersistedTerminal>;
  activeTaskId: string | null;
  sidebarVisible: boolean;
  panelSizes?: Record<string, number>;
  globalScale?: number;
  completedTaskDate?: string;
  completedTaskCount?: number;
  mergedLinesAdded?: number;
  mergedLinesRemoved?: number;
  terminalFont?: string;
  themePreset?: LookPreset;
  showPromptInput?: boolean;
  fontSmoothing?: boolean;
  windowState?: PersistedWindowState;
  autoTrustFolders?: boolean;
  showPlans?: boolean;
  showSteps?: boolean;
  desktopNotificationsEnabled?: boolean;
  inactiveColumnOpacity?: number;
  editorCommand?: string;
  dockerImage?: string;
  askCodeProvider?: 'claude' | 'minimax';
  customAgents?: AgentDef[];
  keybindingMigrationDismissed?: boolean;
  focusMode?: boolean;
}

// Panel cell IDs. Shell terminals use "shell:0", "shell:1", etc.
// Shell toolbar buttons use "shell-toolbar:0", "shell-toolbar:1", etc.
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
  collapsedTaskOrder: string[];
  tasks: Record<string, Task>;
  terminals: Record<string, Terminal>;
  agents: Record<string, Agent>;
  activeTaskId: string | null;
  activeAgentId: string | null;
  availableAgents: AgentDef[];
  customAgents: AgentDef[];
  showNewTaskDialog: boolean;
  sidebarVisible: boolean;
  panelSizes: Record<string, number>;
  globalScale: number;
  taskGitStatus: Record<string, WorktreeStatus>;
  taskViewportVisibility: Record<string, TaskViewportVisibility>;
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
  terminalFont: string;
  themePreset: LookPreset;
  showPromptInput: boolean;
  fontSmoothing: boolean;
  windowState: PersistedWindowState | null;
  autoTrustFolders: boolean;
  showPlans: boolean;
  showSteps: boolean;
  desktopNotificationsEnabled: boolean;
  inactiveColumnOpacity: number;
  editorCommand: string;
  dockerImage: string;
  dockerAvailable: boolean;
  askCodeProvider: 'claude' | 'minimax';
  newTaskDropUrl: string | null;
  newTaskPrefillPrompt: { prompt: string; projectId: string | null } | null;
  missingProjectIds: Record<string, true>;
  remoteAccess: RemoteAccess;
  showArena: boolean;
  keybindingPreset: string;
  /** Per-preset user overrides. Outer key = preset ID, inner = binding ID → override. */
  keybindingOverridesByPreset: Record<string, Record<string, KeybindingOverride>>;
  keybindingMigrationDismissed: boolean;
  focusMode: boolean;
  /** Per-task flag: true when the task is rendering its focus-mode two-column layout. */
  taskSplitMode: Record<string, boolean>;
  /** Per-task memory of the last right-column cell focused, so crossing ai-terminal and back
   *  with the arrow keys returns to where the user was instead of always jumping to `changed-files`. */
  lastRightColFocus: Record<string, string>;
}
