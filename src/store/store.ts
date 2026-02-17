// Barrel file — re-exports from domain modules
export { store } from "./core";
export { getProject, addProject, removeProject, getProjectPath } from "./projects";
export { loadAgents, addAgentToTask, markAgentExited } from "./agents";
export {
  createTask,
  closeTask,
  retryCloseTask,
  mergeTask,
  pushTask,
  updateTaskName,
  updateTaskNotes,
  sendPrompt,
  setLastPrompt,
  reorderTask,
  spawnShellForTask,
  closeShell,
} from "./tasks";
export {
  setActiveTask,
  setActiveAgent,
  navigateTask,
  navigateAgent,
  moveActiveTask,
  toggleNewTaskDialog,
} from "./navigation";
export { saveState, loadState } from "./persistence";
export {
  getFontScale,
  adjustFontScale,
  resetFontScale,
  getGlobalScale,
  adjustGlobalScale,
  resetGlobalScale,
  getPanelSize,
  setPanelSizes,
  toggleSidebar,
} from "./ui";
export {
  getTaskDotStatus,
  markAgentActive,
  clearAgentActivity,
  startTaskStatusPolling,
  stopTaskStatusPolling,
} from "./taskStatus";
export type { TaskDotStatus } from "./taskStatus";
