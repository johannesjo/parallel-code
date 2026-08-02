import { createEffect, onCleanup } from 'solid-js';
import { store, saveState } from './store';

/** Build a snapshot string of all persisted fields. Using JSON.stringify
 *  creates a single reactive dependency on the serialized form — the effect
 *  only re-runs when a persisted value actually changes, instead of on every
 *  individual field mutation (cursor moves, panel resizes, etc.). */
export function persistedSnapshot(): string {
  return JSON.stringify({
    projects: store.projects,
    lastProjectId: store.lastProjectId,
    lastAgentId: store.lastAgentId,
    taskOrder: store.taskOrder,
    collapsedTaskOrder: store.collapsedTaskOrder,
    activeTaskId: store.activeTaskId,
    sidebarVisible: store.sidebarVisible,
    panelUserSize: store.panelUserSize,
    globalScale: store.globalScale,
    completedTaskDate: store.completedTaskDate,
    completedTaskCount: store.completedTaskCount,
    mergedLinesAdded: store.mergedLinesAdded,
    mergedLinesRemoved: store.mergedLinesRemoved,
    terminalFont: store.terminalFont,
    themePreset: store.themePreset,
    windowState: store.windowState,
    autoTrustFolders: store.autoTrustFolders,
    showPlans: store.showPlans,
    defaultStepsEnabled: store.defaultStepsEnabled,
    defaultSkipPermissions: store.defaultSkipPermissions,
    defaultPropagateSkipPermissions: store.defaultPropagateSkipPermissions,
    showSidebarTips: store.showSidebarTips,
    showSidebarProgress: store.showSidebarProgress,
    sidebarNeedsInputFirst: store.sidebarNeedsInputFirst,
    projectsCollapsed: store.projectsCollapsed,
    desktopNotificationsEnabled: store.desktopNotificationsEnabled,
    inactiveColumnOpacity: store.inactiveColumnOpacity,
    editorCommand: store.editorCommand,
    customAgents: store.customAgents,
    focusMode: store.focusMode,
    coordinatorNotificationDelayMs: store.coordinatorNotificationDelayMs,
    coordinatorModeEnabled: store.coordinatorModeEnabled,
    coordinatorControlHintDismissed: store.coordinatorControlHintDismissed,
    autoStartRemoteAccess: store.autoStartRemoteAccess,
    shareDockerAgentAuth: store.shareDockerAgentAuth,
    appearanceMode: store.appearanceMode,
    lightThemePreset: store.lightThemePreset,
    lightThemeCustomId: store.lightThemeCustomId,
    darkThemePreset: store.darkThemePreset,
    darkThemeCustomId: store.darkThemeCustomId,
    tasks: Object.fromEntries(
      [...store.taskOrder, ...store.collapsedTaskOrder]
        .filter((id) => store.tasks[id])
        .map((id) => {
          const t = store.tasks[id];
          return [
            id,
            {
              notes: t.notes,
              lastPrompt: t.lastPrompt,
              name: t.name,
              gitIsolation: t.gitIsolation,
              baseBranch: t.baseBranch,
              branchName: t.branchName,
              externalWorktree: t.externalWorktree,
              savedInitialPrompt: t.savedInitialPrompt,
              collapsed: t.collapsed,
              coordinatedBy: t.coordinatedBy,
              coordinatorMode: t.coordinatorMode,
              mcpConfigPath: t.mcpConfigPath,
              preambleFileExistedBefore: t.preambleFileExistedBefore,
              signalDoneReceived: t.signalDoneReceived,
              signalDoneAt: t.signalDoneAt,
              signalDoneConsumed: t.signalDoneConsumed,
              needsReview: t.needsReview,
              verification: t.verification,
              landingState: t.landingState,
              landingReason: t.landingReason,
              landingSummary: t.landingSummary,
              landedMetadata: t.landedMetadata,
              controlledBy: t.controlledBy,
            },
          ];
        }),
    ),
    terminals: Object.fromEntries(
      store.taskOrder
        .filter((id) => store.terminals[id])
        .map((id) => [id, { name: store.terminals[id].name }]),
    ),
  });
}

export function setupAutosave(): void {
  let timer: number | undefined;
  let lastSnapshot: string | undefined;

  createEffect(() => {
    const snapshot = persistedSnapshot();

    // Skip if nothing actually changed
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;

    clearTimeout(timer);
    timer = window.setTimeout(() => saveState(), 1000);

    onCleanup(() => clearTimeout(timer));
  });
}
