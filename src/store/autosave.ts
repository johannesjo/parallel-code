import { createEffect, onCleanup } from "solid-js";
import { store, saveState } from "./store";

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
    activeTaskId: store.activeTaskId,
    sidebarVisible: store.sidebarVisible,
    fontScales: store.fontScales,
    panelSizes: store.panelSizes,
    globalScale: store.globalScale,
    completedTaskDate: store.completedTaskDate,
    completedTaskCount: store.completedTaskCount,
    terminalFont: store.terminalFont,
    themePreset: store.themePreset,
    windowState: store.windowState,
    autoTrustFolders: store.autoTrustFolders,
    tasks: Object.fromEntries(
      store.taskOrder.map((id) => {
        const t = store.tasks[id];
        return [id, t ? { notes: t.notes, lastPrompt: t.lastPrompt, name: t.name } : null];
      })
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
