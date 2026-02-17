import { createEffect } from "solid-js";
import { store, saveState } from "./store";

export function setupAutosave(): void {
  let timer: number | undefined;

  createEffect(() => {
    // Access reactive fields to track changes
    void store.taskOrder.length;
    void store.activeTaskId;
    void store.sidebarVisible;

    for (const id of store.taskOrder) {
      const t = store.tasks[id];
      if (t) {
        void t.notes;
        void t.collapsed;
        void t.lastPrompt;
        void t.name;
      }
    }

    // Debounce 1s
    clearTimeout(timer);
    timer = window.setTimeout(() => saveState(), 1000);
  });
}
