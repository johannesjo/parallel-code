// Barrel file — re-exports from domain modules
export { store } from './core';
export {
  getProject,
  addProject,
  removeProject,
  removeProjectWithTasks,
  updateProject,
  getProjectPath,
  getProjectBranchPrefix,
  pickAndAddProject,
  PASTEL_HUES,
} from './projects';
export {
  loadAgents,
  addAgentToTask,
  markAgentExited,
  restartAgent,
  addCustomAgent,
  removeCustomAgent,
  updateCustomAgent,
} from './agents';
export {
  createTask,
  createDirectTask,
  closeTask,
  retryCloseTask,
  mergeTask,
  pushTask,
  updateTaskName,
  updateTaskNotes,
  sendPrompt,
  setLastPrompt,
  clearInitialPrompt,
  clearPrefillPrompt,
  setPrefillPrompt,
  reorderTask,
  spawnShellForTask,
  closeShell,
  hasDirectModeTask,
  getGitHubDropDefaults,
  setNewTaskDropUrl,
  setNewTaskPrefillPrompt,
} from './tasks';
export {
  setActiveTask,
  setActiveAgent,
  navigateTask,
  navigateAgent,
  moveActiveTask,
  toggleNewTaskDialog,
} from './navigation';
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
  unfocusPlaceholder,
  navigateRow,
  navigateColumn,
  setPendingAction,
  clearPendingAction,
  toggleHelpDialog,
  toggleSettingsDialog,
  sendActivePrompt,
  setSidebarFocusedProjectId,
} from './focus';
export type { PanelId, PendingAction } from './types';
export { saveState, loadState } from './persistence';
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
  toggleArena,
  setTerminalFont,
  setThemePreset,
  setAutoTrustFolders,
  setInactiveColumnOpacity,
  setWindowState,
} from './ui';
export {
  getTaskDotStatus,
  markAgentActive,
  markAgentOutput,
  clearAgentActivity,
  getAgentOutputTail,
  stripAnsi,
  onAgentReady,
  offAgentReady,
  normalizeForComparison,
  looksLikeQuestion,
  isTrustQuestionAutoHandled,
  isAutoTrustSettling,
  isAgentAskingQuestion,
  startTaskStatusPolling,
  stopTaskStatusPolling,
  rescheduleTaskStatusPolling,
} from './taskStatus';
export type { TaskDotStatus } from './taskStatus';
export { showNotification, clearNotification } from './notification';
export { getCompletedTasksTodayCount, getMergedLineTotals } from './completion';
export {
  createTerminal,
  closeTerminal,
  updateTerminalName,
  syncTerminalCounter,
} from './terminals';
export { startRemoteAccess, stopRemoteAccess, refreshRemoteStatus } from './remote';
