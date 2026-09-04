// Scheduling behaviour of the autosave effect. Lives in the client (happy-dom)
// config: the node config compiles solid-js for SSR, where createEffect is a
// no-op, so the effect under test would never run there.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'solid-js';
import { store, setStore } from './core';
import { setupAutosave, AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS } from './autosave';

const { mockSaveState } = vi.hoisted(() => ({ mockSaveState: vi.fn(async () => {}) }));
vi.mock('./persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./persistence')>()),
  saveState: mockSaveState,
}));
describe('setupAutosave scheduling', () => {
  // Real solid-js reactivity over the real store; only the write is mocked.
  beforeEach(() => {
    vi.useFakeTimers();
    mockSaveState.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function withAutosave(run: () => void): void {
    // Effects created inside createRoot run when the root's setup returns, so
    // the scenario must execute after that. The initial effect pass schedules
    // one startup save (as it always has); let it land and discard it so each
    // scenario starts from a quiet, saved state.
    const dispose = createRoot((d) => {
      setupAutosave();
      return d;
    });
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    mockSaveState.mockClear();
    try {
      run();
    } finally {
      dispose();
    }
  }

  it('debounces a burst of changes into one save after the quiet period', () => {
    withAutosave(() => {
      setStore('showSidebarTips', !store.showSidebarTips);
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1);
      setStore('showSidebarTips', !store.showSidebarTips);
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1);
      expect(mockSaveState).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(mockSaveState).toHaveBeenCalledTimes(1);
    });
  });

  it('never postpones a save past the max wait while changes keep arriving', () => {
    withAutosave(() => {
      // Simulate continuous typing: a change every 500ms for 12 seconds.
      const step = 500;
      let saves = 0;
      for (let elapsed = 0; elapsed < 12_000; elapsed += step) {
        setStore('showSidebarTips', !store.showSidebarTips);
        vi.advanceTimersByTime(step);
        saves = mockSaveState.mock.calls.length;
        // Before the max wait elapses no save is forced...
        if (elapsed + step < AUTOSAVE_MAX_WAIT_MS) expect(saves).toBe(0);
      }
      // ...but over 12s of nonstop edits at least two saves were written.
      expect(saves).toBeGreaterThanOrEqual(2);
    });
  });

  it('does not save when nothing persisted changed', () => {
    withAutosave(() => {
      setStore('notification', 'transient toast');
      vi.advanceTimersByTime(AUTOSAVE_MAX_WAIT_MS * 2);
      expect(mockSaveState).not.toHaveBeenCalled();
    });
  });

  it('flushes a pending save when the owner is disposed', () => {
    withAutosave(() => {
      setStore('showSidebarTips', !store.showSidebarTips);
      expect(mockSaveState).not.toHaveBeenCalled();
    });
    expect(mockSaveState).toHaveBeenCalledTimes(1);
  });
});
