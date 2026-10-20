import { describe, expect, it } from 'vitest';
import { restoreWindow, type RestorableWindow } from './window-restore.js';

interface FakeWindow extends RestorableWindow {
  calls: string[];
}

function fakeWindow(
  state: { destroyed?: boolean; visible?: boolean; minimized?: boolean } = {},
): FakeWindow {
  const calls: string[] = [];
  return {
    calls,
    isDestroyed: () => state.destroyed ?? false,
    isVisible: () => state.visible ?? true,
    isMinimized: () => state.minimized ?? false,
    show: () => void calls.push('show'),
    restore: () => void calls.push('restore'),
    focus: () => void calls.push('focus'),
  };
}

describe('restoreWindow', () => {
  // The case the whole function exists for: "Keep them alive in the background"
  // hides the window, and without `show()` there is no way back to it at all.
  it('shows a hidden window and focuses it', () => {
    const win = fakeWindow({ visible: false });
    restoreWindow(win);
    expect(win.calls).toEqual(['show', 'focus']);
  });

  // A handler that only called `show()` would leave a minimized window where it
  // was: `restore()` is the call that un-minimizes.
  it('restores a minimized window and focuses it', () => {
    const win = fakeWindow({ minimized: true });
    restoreWindow(win);
    expect(win.calls).toEqual(['restore', 'focus']);
  });

  // The two states are not exclusive, and the function must not treat them as
  // such — a window can be hidden and minimized at the same time.
  it('handles a window that is both hidden and minimized', () => {
    const win = fakeWindow({ visible: false, minimized: true });
    restoreWindow(win);
    expect(win.calls).toEqual(['show', 'restore', 'focus']);
  });

  // Visible but buried behind another app: nothing to show or restore, but the
  // user asked for this window, so it still has to come forward.
  it('focuses a window that is already visible', () => {
    const win = fakeWindow();
    restoreWindow(win);
    expect(win.calls).toEqual(['focus']);
  });

  // The window is nulled on `closed`, but these events can arrive in the gap
  // before that fires, and calling into a destroyed window throws.
  it('is a no-op for a destroyed window', () => {
    const win = fakeWindow({ destroyed: true, visible: false, minimized: true });
    expect(() => restoreWindow(win)).not.toThrow();
    expect(win.calls).toEqual([]);
  });

  it('is a no-op for a missing window', () => {
    expect(() => restoreWindow(null)).not.toThrow();
    expect(() => restoreWindow(undefined)).not.toThrow();
  });
});
