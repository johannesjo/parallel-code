import { createStore } from "solid-js/store";
import { getLocalDateKey } from "../lib/date";
import type { AppStore } from "./types";

export const [store, setStore] = createStore<AppStore>({
  projects: [],
  lastProjectId: null,
  lastAgentId: null,
  taskOrder: [],
  tasks: {},
  agents: {},
  activeTaskId: null,
  activeAgentId: null,
  availableAgents: [],
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
  showHelpDialog: false,
  showSettingsDialog: false,
  pendingAction: null,
  notification: null,
  completedTaskDate: getLocalDateKey(),
  completedTaskCount: 0,
  mergedLinesAdded: 0,
  mergedLinesRemoved: 0,
  themePreset: "graphite",
  windowState: null,
});

export function updateWindowTitle(_taskName?: string): void {
  // Intentionally no-op: window title text is hidden in the custom/native title bars.
}
