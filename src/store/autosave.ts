import { createEffect } from "solid-js";
import { store, saveState } from "./store";

export function setupAutosave(): void {
  let timer: number | undefined;

  createEffect(() => {
    // Access reactive fields to track changes
    void store.taskOrder.length;
    void store.activeTaskId;
    void store.sidebarVisible;
    void store.globalScale;
    void store.completedTaskDate;
    void store.completedTaskCount;
    void store.themePreset;
    void store.windowState?.x;
    void store.windowState?.y;
    void store.windowState?.width;
    void store.windowState?.height;
    void store.windowState?.maximized;
    void store.projects.length;
    void store.lastProjectId;
    void store.lastAgentId;

    for (const p of store.projects) {
      void p.name;
      void p.path;
    }

    for (const id of store.taskOrder) {
      const t = store.tasks[id];
      if (t) {
        void t.notes;
        void t.lastPrompt;
        void t.name;
      }
    }
    for (const key of Object.keys(store.fontScales)) {
      void store.fontScales[key];
    }
    for (const key of Object.keys(store.panelSizes)) {
      void store.panelSizes[key];
    }

    // Debounce 1s
    clearTimeout(timer);
    timer = window.setTimeout(() => saveState(), 1000);
  });
}
