// Bringing the main window back from wherever the user left it.
//
// "Keep them alive in the background" hides the window rather than closing it,
// which is the whole point — the agents keep running. But a hidden window is
// only useful if there is a way back to it, and `show()` alone is not that way:
// a window the user minimized is still "visible" to Electron, so `show()` is a
// no-op on it, and a window that is visible but buried behind other apps needs
// `focus()` to come forward. Each entry point (dock click, second launch, tray)
// can hit any of those three states, so they all route through one function
// that handles all three rather than each guessing.
//
// Typed structurally instead of against `BrowserWindow` so the behaviour can be
// tested without an Electron runtime. `BrowserWindow` satisfies this shape.
export interface RestorableWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  show(): void;
  restore(): void;
  focus(): void;
}

/**
 * Bring `win` back into view, whatever state it is in: hidden, minimized,
 * behind another app, or any combination.
 *
 * A no-op for a missing or destroyed window — the window is set to null on
 * `closed`, but the events that call this can arrive in the gap before that
 * fires, and calling into a destroyed window throws.
 */
export function restoreWindow(win: RestorableWindow | null | undefined): void {
  if (!win || win.isDestroyed()) return;
  // Order matters: a minimized window reports `isVisible() === false` on some
  // platforms and `true` on others, so ask both questions and act on each.
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}
