import { createEffect, createRoot, on } from 'solid-js';
import { store } from './core';

let current: string | null = null;
let previous: string | null = null;

/**
 * Remembers the last two tasks that were active, however they were opened, so
 * Ctrl+Shift+Tab can go back. Returns a stop function.
 */
export function startPreviousTaskTracker(): () => void {
  return createRoot((dispose) => {
    createEffect(
      on(
        () => store.activeTaskId,
        (id) => {
          // Project pages and the board clear the active task, and terminals
          // are not tasks; coming back to the same task is not a switch.
          if (!id || id === current || !store.tasks[id]) return;
          previous = current;
          current = id;
        },
      ),
    );
    return () => {
      dispose();
      current = null;
      previous = null;
    };
  });
}

/**
 * The task to go back to: the one before the current task, or the last task
 * when something else (a terminal, a project page) is showing now.
 */
export function previousTaskId(): string | null {
  return store.activeTaskId === current ? previous : current;
}
