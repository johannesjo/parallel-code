// Barrel file — re-exports from domain modules
export { store } from "./core";
export { getProject, addProject, removeProject, getProjectPath } from "./projects";
export { loadAgents, addAgentToTask, markAgentExited } from "./agents";
export {
  createTask,
  closeTask,
  retryCloseTask,
  mergeTask,
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
  getPanelSize,
  setPanelSizes,
  toggleSidebar,
} from "./ui";
