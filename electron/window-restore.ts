// Bringing the main window back from wherever the user left it.
//
// "Keep them alive in the background" hides the window rather than closing it,
// which is the whole point — the agents keep running. But a hidden window is
// only useful if there is a way back to it, and the entry points that ask for
// it (a dock click, a second launch) can arrive with the window hidden,
// minimized, or merely behind another app. Each of those needs a different call,
// so they all route through one function that makes all three rather than each
// caller guessing which one applies.
//
// Wayland caveat: a client generally cannot raise itself there, and Electron's
// own docs say `focus()` on Wayland "may show a notification or flash the app
// icon" instead. So the visible-but-buried case can end at an icon flash rather
// than a raise, depending on the compositor. Hidden and minimized are unaffected.
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
  // Both questions get asked, and each answer gets acted on independently: the
  // two states are not exclusive, and how a minimized window reports its
  // visibility is not something to depend on.
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}
