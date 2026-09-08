import { describe, expect, it, vi } from 'vitest';
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

  // `show()` is a no-op on a minimized window, so a handler that only called
  // `show()` would leave the user's click doing nothing at all.
  it('restores a minimized window and focuses it', () => {
    const win = fakeWindow({ minimized: true });
    restoreWindow(win);
    expect(win.calls).toEqual(['restore', 'focus']);
  });

  // Minimized windows report themselves as not visible on some platforms;
  // both branches have to run or one of the two platforms is left broken.
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

  // Guard clauses must not swallow the calls they guard: a regression that made
  // `isDestroyed()` throw would otherwise look like a passing no-op test.
  it('asks whether the window is destroyed before touching it', () => {
    const isDestroyed = vi.fn(() => false);
    const win = { ...fakeWindow(), isDestroyed };
    restoreWindow(win);
    expect(isDestroyed).toHaveBeenCalled();
  });
});
