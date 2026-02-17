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
});

export function updateWindowTitle(taskName?: string): void {
  const title = taskName ? `AI Mush - ${taskName}` : "AI Mush";
  getCurrentWindow().setTitle(title).catch(() => {});
}
