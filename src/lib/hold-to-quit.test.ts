import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHoldToQuit, HOLD_TO_QUIT_MS } from './hold-to-quit';

type KeyDownStub = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'preventDefault'
>;

function setup() {
  const events = { holds: [] as boolean[], quit: 0 };
  const controller = createHoldToQuit({
    onHoldChange: (holding) => events.holds.push(holding),
    onQuit: () => (events.quit += 1),
  });
  const preventDefault = vi.fn();
  const key = (overrides: Partial<KeyDownStub> = {}): KeyDownStub => ({
    key: 'q',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    preventDefault,
    ...overrides,
  });
  return { controller, events, preventDefault, key };
}

describe('createHoldToQuit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not quit on a tap', () => {
    const { controller, events, key } = setup();

    controller.handleKeyDown(key());
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS - 1);
    controller.handleKeyUp({ key: 'q' });
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS);

    expect(events.quit).toBe(0);
    expect(events.holds).toEqual([true, false]);
  });

  it('quits once the key has been held long enough', () => {
    const { controller, events, key } = setup();

    controller.handleKeyDown(key());
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS);

    expect(events.quit).toBe(1);
    // The hint goes away before the quit — no stale overlay over the dialog.
    expect(events.holds).toEqual([true, false]);
  });

  it('swallows the keystroke so a tap does nothing at all', () => {
    const { controller, preventDefault, key } = setup();

    controller.handleKeyDown(key());

    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('cancels when Command is released, which macOS reports even if "q" is not', () => {
    const { controller, events, key } = setup();

    controller.handleKeyDown(key());
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS - 1);
    controller.handleKeyUp({ key: 'Meta' });
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS);

    expect(events.quit).toBe(0);
    expect(events.holds).toEqual([true, false]);
  });

  it('cancels on any other key, since Command is then anchoring something else', () => {
    const { controller, events, key } = setup();

    controller.handleKeyDown(key());
    controller.handleKeyDown(key({ key: 'Tab' }));
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS);

    expect(events.quit).toBe(0);
    expect(events.holds).toEqual([true, false]);
  });

  it('keeps holding through modifier keydowns', () => {
    const { controller, events, key } = setup();

    controller.handleKeyDown(key());
    controller.handleKeyDown(key({ key: 'Meta' }));
    controller.handleKeyDown(key({ key: 'Shift', shiftKey: true }));
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS);

    expect(events.quit).toBe(1);
  });

  it('cancels on blur', () => {
    const { controller, events, key } = setup();

    controller.handleKeyDown(key());
    controller.cancel();
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS);

    expect(events.quit).toBe(0);
    expect(events.holds).toEqual([true, false]);
  });

  it('does not restart the hold on auto-repeat', () => {
    const { controller, events, key } = setup();

    controller.handleKeyDown(key());
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS - 10);
    controller.handleKeyDown(key({ repeat: true }));
    controller.handleKeyDown(key({ repeat: true }));
    vi.advanceTimersByTime(10);

    expect(events.quit).toBe(1);
    expect(events.holds).toEqual([true, false]);
  });

  it('ignores plain "q" and Cmd chords that carry extra modifiers', () => {
    const { controller, events, preventDefault, key } = setup();

    controller.handleKeyDown(key({ metaKey: false }));
    controller.handleKeyDown(key({ shiftKey: true }));
    controller.handleKeyDown(key({ altKey: true }));
    controller.handleKeyDown(key({ ctrlKey: true }));
    controller.handleKeyDown(key({ key: 'w' }));
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS * 2);

    expect(events.holds).toEqual([]);
    expect(events.quit).toBe(0);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('is idempotent when a stray keyup arrives with no hold in progress', () => {
    const { controller, events } = setup();

    controller.handleKeyUp({ key: 'Meta' });
    controller.cancel();

    expect(events.holds).toEqual([]);
  });

  it('can quit on a second hold after the first was cancelled', () => {
    const { controller, events, key } = setup();

    controller.handleKeyDown(key());
    controller.handleKeyUp({ key: 'q' });
    controller.handleKeyDown(key());
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS);

    expect(events.quit).toBe(1);
    expect(events.holds).toEqual([true, false, true, false]);
  });

  // Documents the known gap: macOS withholds the 'q' keyup while Command is
  // down, so a release we never hear about still completes the hold. The close
  // confirmation is what stops that from destroying anything.
  it('still completes when only "q" is released and Command stays down', () => {
    const { controller, events, key } = setup();

    controller.handleKeyDown(key());
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS);

    expect(events.quit).toBe(1);
  });
});
