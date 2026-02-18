import { createStore } from "solid-js/store";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  pendingAction: null,
  notification: null,
});

export function updateWindowTitle(taskName?: string): void {
  const title = taskName ? `Parallel Code - ${taskName}` : "Parallel Code";
  getCurrentWindow().setTitle(title).catch(() => {});
}
