import { createEffect, onCleanup } from "solid-js";

/**
 * Saves the currently focused element when `open` becomes true,
 * and restores focus to it when `open` becomes false or the
 * component unmounts.
 */
export function createFocusRestore(open: () => boolean): void {
  let saved: HTMLElement | null = null;

  function restore(): void {
    if (!saved) return;
    const el = saved;
    saved = null;
    requestAnimationFrame(() => {
      // Don't steal focus if the user already clicked on a meaningful target
      // (e.g. clicked a task panel to dismiss the dialog). Only restore if
      // focus is on <body> or no element, which means nothing else claimed it.
      const current = document.activeElement;
      if (current && current !== document.body) return;
      if (el.isConnected) el.focus();
    });
  }

  createEffect(() => {
    if (open()) {
      saved = document.activeElement as HTMLElement | null;
    } else {
      restore();
    }
  });

  // Also restore on unmount (for dialogs that are conditionally rendered)
  onCleanup(restore);
}
