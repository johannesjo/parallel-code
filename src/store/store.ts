// Barrel file — re-exports from domain modules
export { store } from "./core";
export { getProject, addProject, removeProject, removeProjectWithTasks, updateProject, getProjectPath, getProjectBranchPrefix, pickAndAddProject, PASTEL_HUES } from "./projects";
export { loadAgents, addAgentToTask, markAgentExited, restartAgent } from "./agents";
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
  clearInitialPrompt,
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
export {
  registerFocusFn,
  unregisterFocusFn,
  triggerFocus,
  registerAction,
  unregisterAction,
  triggerAction,
  getTaskFocusedPanel,
  setTaskFocusedPanel,
  focusSidebar,
  unfocusSidebar,
  navigateRow,
  navigateColumn,
  setPendingAction,
  clearPendingAction,
  toggleHelpDialog,
  toggleSettingsDialog,
  sendActivePrompt,
  setSidebarFocusedProjectId,
} from "./focus";
export type { PanelId, PendingAction } from "./types";
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
  setThemePreset,
} from "./ui";
export {
  getTaskDotStatus,
  markAgentActive,
  markAgentOutput,
  clearAgentActivity,
  startTaskStatusPolling,
  stopTaskStatusPolling,
} from "./taskStatus";
export type { TaskDotStatus } from "./taskStatus";
export { showNotification, clearNotification } from "./notification";
export { getCompletedTasksTodayCount } from "./completion";
