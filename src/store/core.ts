import { createStore } from 'solid-js/store';
import { DEFAULT_TERMINAL_FONT } from '../lib/fonts';
import { getLocalDateKey } from '../lib/date';
import type { AppStore } from './types';

export const [store, setStore] = createStore<AppStore>({
  projects: [],
  lastProjectId: null,
  lastAgentId: null,
  taskOrder: [],
  collapsedTaskOrder: [],
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
  showPlans: true,
  desktopNotificationsEnabled: false,
  inactiveColumnOpacity: 0.6,
  editorCommand: '',
  newTaskDropUrl: null,
  newTaskPrefillPrompt: null,
  missingProjectIds: {},
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

/** Remove fontScales, panelSizes, focusedPanel, and taskOrder entries for a given ID.
 *  Call inside a `produce` callback. Returns the index the item had in taskOrder. */
export function cleanupPanelEntries(s: AppStore, id: string): number {
  const idx = s.taskOrder.indexOf(id);
  delete s.focusedPanel[id];
  const prefix = id + ':';
  for (const key of Object.keys(s.fontScales)) {
    if (key === id || key.startsWith(prefix)) delete s.fontScales[key];
  }
  for (const key of Object.keys(s.panelSizes)) {
    if (key.includes(id)) delete s.panelSizes[key];
  }
  s.taskOrder = s.taskOrder.filter((x) => x !== id);
  s.collapsedTaskOrder = s.collapsedTaskOrder.filter((x) => x !== id);
  return idx;
}
