import { createEffect } from 'solid-js';
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
    terminalScreenReaderMode: store.terminalScreenReaderMode,
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
    agentEnvFiles: store.agentEnvFiles,
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
              branchAdoptedFrom: t.branchAdoptedFrom,
              branchOfferDismissed: t.branchOfferDismissed,
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
              verificationRun: t.verificationRun,
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

/** Quiet period after the last change before a save is written. */
export const AUTOSAVE_DEBOUNCE_MS = 1000;
/** Upper bound on how long a save may be postponed by a continuous stream of
 *  changes (typing in the notes panel, for example). Without this the trailing
 *  debounce never fires while the user keeps typing, and a crash or force-quit
 *  loses the whole session. */
export const AUTOSAVE_MAX_WAIT_MS = 5000;

export function setupAutosave(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSnapshot: string | undefined;
  // When the first unsaved change of the current burst happened.
  let pendingSince: number | undefined;

  const flush = () => {
    timer = undefined;
    pendingSince = undefined;
    void saveState();
  };

  createEffect(() => {
    const snapshot = persistedSnapshot();

    // Skip if nothing actually changed
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;

    const now = Date.now();
    pendingSince ??= now;
    if (timer !== undefined) clearTimeout(timer);
    // Trailing debounce, but never later than MAX_WAIT after the burst began.
    const delay = Math.max(
      0,
      Math.min(AUTOSAVE_DEBOUNCE_MS, pendingSince + AUTOSAVE_MAX_WAIT_MS - now),
    );
    timer = setTimeout(flush, delay);
  });
}
