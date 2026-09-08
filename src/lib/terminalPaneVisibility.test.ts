import { describe, expect, it } from 'vitest';
import { isTerminalPaneOnScreen } from './terminalPaneVisibility';

const base = { focusMode: false, activeTaskId: 't1', taskId: 't1', viewportVisibility: undefined };

describe('isTerminalPaneOnScreen', () => {
  it('in tiling mode, only fully off-screen tasks are hidden', () => {
    expect(isTerminalPaneOnScreen({ ...base, viewportVisibility: undefined })).toBe(true);
    expect(isTerminalPaneOnScreen({ ...base, viewportVisibility: 'visible' })).toBe(true);
    expect(isTerminalPaneOnScreen({ ...base, viewportVisibility: 'offscreen-left' })).toBe(false);
    expect(isTerminalPaneOnScreen({ ...base, viewportVisibility: 'offscreen-right' })).toBe(false);
  });

  it('in focus mode, only the active task is on screen regardless of tiling measurements', () => {
    expect(isTerminalPaneOnScreen({ ...base, focusMode: true })).toBe(true);
    expect(isTerminalPaneOnScreen({ ...base, focusMode: true, activeTaskId: 't2' })).toBe(false);
    expect(isTerminalPaneOnScreen({ ...base, focusMode: true, activeTaskId: null })).toBe(false);
    // A stale offscreen measurement from tiling mode must not hide the active task.
    expect(
      isTerminalPaneOnScreen({ ...base, focusMode: true, viewportVisibility: 'offscreen-left' }),
    ).toBe(true);
  });

  it('a standalone pane (arena overlay) ignores task-level focus and tiling state', () => {
    expect(
      isTerminalPaneOnScreen({ ...base, standalone: true, focusMode: true, activeTaskId: 'other' }),
    ).toBe(true);
    expect(
      isTerminalPaneOnScreen({ ...base, standalone: true, viewportVisibility: 'offscreen-left' }),
    ).toBe(true);
    expect(isTerminalPaneOnScreen({ ...base, standalone: true, paneVisible: false })).toBe(false);
  });

  it('a hidden tab pane is off screen even when its task is visible', () => {
    expect(isTerminalPaneOnScreen({ ...base, paneVisible: false })).toBe(false);
    expect(isTerminalPaneOnScreen({ ...base, paneVisible: true })).toBe(true);
    expect(isTerminalPaneOnScreen({ ...base, focusMode: true, paneVisible: false })).toBe(false);
  });
});
