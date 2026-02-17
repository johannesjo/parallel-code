import { createEffect } from "solid-js";
import { store, saveState } from "./store";

export function setupAutosave(): void {
  let timer: number | undefined;

  createEffect(() => {
    // Access reactive fields to track changes
    void store.taskOrder.length;
    void store.activeTaskId;
    void store.sidebarVisible;
    void store.projects.length;
    void store.lastProjectId;

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
      void store.fontScales[id];
    }
    void store.fontScales["sidebar"];

    // Debounce 1s
    clearTimeout(timer);
    timer = window.setTimeout(() => saveState(), 1000);
  });
}
