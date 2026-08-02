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
  panelUserSize: {},
  globalScale: 1,
  taskGitStatus: {},
  taskViewportVisibility: {},
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
  themePreset: 'islands-dark',
  appearanceMode: 'dark',
  lightThemePreset: 'islands-light',
  lightThemeCustomId: null,
  darkThemePreset: 'islands-dark',
  darkThemeCustomId: null,
  showPromptInput: true,
  fontSmoothing: true,
  windowState: null,
  autoTrustFolders: false,
  showPlans: true,
  showSidebarTips: true,
  showSidebarProgress: true,
  sidebarNeedsInputFirst: true,
  projectsCollapsed: false,
  desktopNotificationsEnabled: false,
  inactiveColumnOpacity: 0.6,
  editorCommand: '',
  dockerImage: 'parallel-code-agent:latest',
  dockerAvailable: false,
  shareDockerAgentAuth: false,
  askCodeProvider: 'claude',
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
  autoStartRemoteAccess: false,
  showArena: false,
  keybindingPreset: 'default',
  keybindingOverridesByPreset: {},
  keybindingMigrationDismissed: false,
  focusMode: false,
  taskSplitMode: {},
  verboseLogging: false,
  coordinatorModeEnabled: false,
  coordinatorNotificationDelayMs: 60_000,
  coordinatorControlHintDismissed: false,
  defaultStepsEnabled: false,
  defaultSkipPermissions: false,
  defaultPropagateSkipPermissions: false,
  customThemes: {},
  activeCustomThemeId: null,
  mcpStatus: { running: false, port: null, coordinatorTaskId: null, mcpConfigPath: null },
});

type CleanupPanelStore = Pick<
  AppStore,
  'focusedPanel' | 'panelUserSize' | 'taskOrder' | 'collapsedTaskOrder' | 'taskSplitMode'
>;

/** Remove panelUserSize, focusedPanel, and taskOrder entries for a given ID.
 *  Call inside a `produce` callback. Returns the index the item had in taskOrder.
 *
 *  Panel entries live under three key shapes for a given task/terminal:
 *    - `${id}` / `${id}:*`                     (legacy / bare-id tree)
 *    - `task:${id}` / `task:${id}:*`           (TaskPanel nested trees)
 *    - `tiling:${id}`                          (TilingLayout horizontal strip)
 *  All three are scrubbed so closed items don't leak persistent state. */
export function cleanupPanelEntries(s: CleanupPanelStore, id: string): number {
  const idx = s.taskOrder.indexOf(id);
  delete s.focusedPanel[id];
  delete s.taskSplitMode[id];
  const prefixes = [id, `task:${id}`, `tiling:${id}`];
  for (const key of Object.keys(s.panelUserSize)) {
    if (prefixes.some((p) => key === p || key.startsWith(`${p}:`))) {
      delete s.panelUserSize[key];
    }
  }
  s.taskOrder = s.taskOrder.filter((x) => x !== id);
  s.collapsedTaskOrder = s.collapsedTaskOrder.filter((x) => x !== id);
  return idx;
}
