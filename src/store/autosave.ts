import { createEffect, onCleanup } from 'solid-js';
import { store, saveState } from './store';

/** Build a snapshot string of all persisted fields. Using JSON.stringify
 *  creates a single reactive dependency on the serialized form — the effect
 *  only re-runs when a persisted value actually changes, instead of on every
 *  individual field mutation (cursor moves, panel resizes, etc.). */
function persistedSnapshot(): string {
  return JSON.stringify({
    projects: store.projects,
    lastProjectId: store.lastProjectId,
    lastAgentId: store.lastAgentId,
    taskOrder: store.taskOrder,
    collapsedTaskOrder: store.collapsedTaskOrder,
    activeTaskId: store.activeTaskId,
    sidebarVisible: store.sidebarVisible,
    fontScales: store.fontScales,
    panelSizes: store.panelSizes,
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
    desktopNotificationsEnabled: store.desktopNotificationsEnabled,
    inactiveColumnOpacity: store.inactiveColumnOpacity,
    editorCommand: store.editorCommand,
    customAgents: store.customAgents,
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
              directMode: t.directMode,
              savedInitialPrompt: t.savedInitialPrompt,
              collapsed: t.collapsed,
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
