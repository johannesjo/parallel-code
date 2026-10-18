import { describe, expect, it } from 'vitest';
import { placeHint } from './feature-hint-placement';

const viewport = { width: 1400, height: 700 };
const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe('placeHint', () => {
  it('hangs under the anchor, right-aligned, with the caret at its centre', () => {
    expect(placeHint(rect(400, 100, 200, 30), viewport, 300, 190)).toEqual({
      left: 300,
      top: 138,
      maxHeight: 550,
      caret: { side: 'top', offset: 200 },
    });
  });

  it('sits above an anchor near the bottom, held by its bottom edge', () => {
    const placed = placeHint(rect(400, 600, 200, 30), viewport, 300, 190);
    expect(placed.top).toBeUndefined();
    expect(placed.bottom).toBe(108);
    expect(placed.caret.side).toBe('bottom');
  });

  it('keeps the card and its caret inside the viewport', () => {
    const placed = placeHint(rect(0, 100, 40, 30), viewport, 300, 190);
    expect(placed.left).toBe(12);
    expect(placed.caret.offset).toBe(16);
  });

  it('sits beside a dialog, level with the anchor, covering none of it', () => {
    const panel = rect(420, 240, 560, 220);
    const placed = placeHint(rect(450, 340, 500, 300), viewport, 300, 190, panel);
    expect(placed).toEqual({
      left: 988,
      top: 324,
      maxHeight: 364,
      caret: { side: 'left', offset: 32 },
    });
  });

  it('takes the left side of a dialog when the right has no room', () => {
    const panel = rect(800, 240, 560, 220);
    const placed = placeHint(rect(830, 300, 500, 20), viewport, 300, 190, panel);
    expect(placed.left).toBe(492);
    expect(placed.caret.side).toBe('right');
  });

  it('goes under, then over, a dialog too wide to sit beside', () => {
    const narrow = { width: 940, height: 640 };
    const under = placeHint(rect(220, 310, 500, 20), narrow, 300, 190, rect(190, 214, 560, 212));
    expect(under.top).toBe(434);
    expect(under.caret.side).toBe('top');

    const over = placeHint(rect(220, 420, 500, 20), narrow, 300, 190, rect(190, 300, 560, 300));
    expect(over.bottom).toBe(348);
    expect(over.caret.side).toBe('bottom');
  });

  it('overlaps a dialog only when there is no room around it', () => {
    const placed = placeHint(rect(220, 200, 500, 20), viewport, 300, 190, rect(0, 60, 1400, 580));
    expect(placed.top).toBe(228);
  });
});
