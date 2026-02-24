import { createStore } from 'solid-js/store';
import { DEFAULT_TERMINAL_FONT } from '../lib/fonts';
import { getLocalDateKey } from '../lib/date';
import type { AppStore } from './types';

export const [store, setStore] = createStore<AppStore>({
  projects: [],
  lastProjectId: null,
  lastAgentId: null,
  taskOrder: [],
  tasks: {},
  terminals: {},
  agents: {},
  activeTaskId: null,
  activeAgentId: null,
  availableAgents: [],
  customAgents: [],
  showNewTaskDialog: false,
  sidebarVisible: true,
  fontScales: {},
  panelSizes: {},
  globalScale: 1,
  taskGitStatus: {},
  focusedPanel: {},
  sidebarFocused: false,
  sidebarFocusedProjectId: null,
  sidebarFocusedTaskId: null,
  placeholderFocused: false,
  placeholderFocusedButton: 'add-task',
  showHelpDialog: false,
  showSettingsDialog: false,
  pendingAction: null,
  notification: null,
  completedTaskDate: getLocalDateKey(),
  completedTaskCount: 0,
  mergedLinesAdded: 0,
  mergedLinesRemoved: 0,
  terminalFont: DEFAULT_TERMINAL_FONT,
  themePreset: 'minimal',
  windowState: null,
  autoTrustFolders: false,
  inactiveColumnOpacity: 0.6,
  newTaskDropUrl: null,
  newTaskPrefillPrompt: null,
  remoteAccess: {
    enabled: false,
    token: null,
    port: 7777,
    url: null,
    wifiUrl: null,
    tailscaleUrl: null,
    connectedClients: 0,
  },
  showArena: false,
});

export function updateWindowTitle(_taskName?: string): void {
  // Intentionally no-op: window title text is hidden in the custom/native title bars.
}
