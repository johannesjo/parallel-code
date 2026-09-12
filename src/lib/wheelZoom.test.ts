// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createCtrlShiftWheelResizeHandler, createCtrlWheelZoomHandler } from './wheelZoom';

// happy-dom's WheelEvent omits mouse modifier properties.
function wheelEvent(init: WheelEventInit): WheelEvent {
  return Object.assign(new WheelEvent('wheel', init), {
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
  });
}

describe('Ctrl+Shift+wheel resize', () => {
  it.each([
    { deltaX: -100, deltaY: 0 },
    { deltaX: 0, deltaY: -100 },
    { deltaX: 20, deltaY: -100 },
  ])('enlarges panels for wheel input %j', (deltas) => {
    const onStep = vi.fn();
    const event = wheelEvent({
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
      ...deltas,
    });

    createCtrlShiftWheelResizeHandler(onStep)(event);

    expect(onStep).toHaveBeenCalledExactlyOnceWith(30);
    expect(event.defaultPrevented).toBe(true);
  });

  it('accumulates horizontal deltas and resets on reversal', () => {
    const onStep = vi.fn();
    const handleWheel = createCtrlShiftWheelResizeHandler(onStep);
    for (const deltaX of [60, -60, -40]) {
      handleWheel(wheelEvent({ ctrlKey: true, shiftKey: true, deltaX }));
    }
    expect(onStep).toHaveBeenCalledExactlyOnceWith(30);
  });

  it.each([
    { deltaMode: WheelEvent.DOM_DELTA_LINE, deltaX: 7, expected: -30 },
    { deltaMode: WheelEvent.DOM_DELTA_PAGE, deltaX: 1, expected: -240 },
  ])('normalizes horizontal wheel units %j', ({ deltaMode, deltaX, expected }) => {
    const onStep = vi.fn();
    createCtrlShiftWheelResizeHandler(onStep)(
      wheelEvent({ ctrlKey: true, shiftKey: true, deltaMode, deltaX }),
    );
    expect(onStep).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each([{ ctrlKey: true }, { shiftKey: true }, {}])(
    'leaves scrolling alone without both modifiers: %j',
    (modifiers) => {
      const onStep = vi.fn();
      const event = wheelEvent({ ...modifiers, deltaX: 100, cancelable: true });
      createCtrlShiftWheelResizeHandler(onStep)(event);
      expect(onStep).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    },
  );
});

describe('Ctrl+wheel zoom', () => {
  it('still zooms from vertical movement only', () => {
    const onStep = vi.fn();
    const handleWheel = createCtrlWheelZoomHandler(onStep);
    handleWheel(wheelEvent({ ctrlKey: true, deltaX: -100 }));
    expect(onStep).not.toHaveBeenCalled();
    handleWheel(wheelEvent({ ctrlKey: true, deltaY: -100 }));
    expect(onStep).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('does not zoom when resizing', () => {
    const onStep = vi.fn();
    createCtrlWheelZoomHandler(onStep)(wheelEvent({ ctrlKey: true, shiftKey: true, deltaY: -100 }));
    expect(onStep).not.toHaveBeenCalled();
  });
});
