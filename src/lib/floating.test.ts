import { describe, expect, it } from 'vitest';
import { placeBelow } from './floating';

const viewport = { width: 1000, height: 800 };

describe('placeBelow', () => {
  it('hangs the overlay flush under the anchor, right-aligned with it', () => {
    const place = placeBelow({ right: 700, bottom: 300 }, 400, viewport);
    expect(place.top).toBe(302);
    expect(place.right).toBe(300);
    expect(place.maxHeight).toBe(800 - 302 - 12);
  });

  it('keeps an anchor at the window edge from pushing the overlay off it', () => {
    // A marker in the margin can sit past the right edge of the window.
    expect(placeBelow({ right: 1010, bottom: 10 }, 400, viewport).right).toBe(12);
    // Near the left edge, right-alignment would run the overlay off the left.
    expect(placeBelow({ right: 100, bottom: 10 }, 400, viewport).right).toBe(1000 - 400 - 12);
  });

  it('leaves the overlay at least a little room when the anchor is near the bottom', () => {
    expect(placeBelow({ right: 500, bottom: 790 }, 400, viewport).maxHeight).toBe(120);
  });

  it('goes above an anchor near the bottom once it knows it would not fit below', () => {
    const anchor = { top: 700, right: 500, bottom: 720 };
    // Without a height there is nothing to compare, so the overlay stays below.
    expect(placeBelow(anchor, 400, viewport).top).toBe(722);
    const above = placeBelow(anchor, 400, viewport, 12, 300);
    expect(above.top).toBe(700 - 2 - 300);
    expect(above.maxHeight).toBe(700 - 2 - 12);
  });

  it('stays below while the overlay fits there, and when there is even less room above', () => {
    expect(placeBelow({ top: 100, right: 500, bottom: 120 }, 400, viewport, 12, 300).top).toBe(122);
    expect(placeBelow({ top: 40, right: 500, bottom: 760 }, 400, viewport, 12, 300).top).toBe(762);
  });

  it('pins a taller-than-the-room overlay to the top edge when flipped', () => {
    const place = placeBelow({ top: 500, right: 500, bottom: 780 }, 400, viewport, 12, 900);
    expect(place.top).toBe(12);
    expect(place.maxHeight).toBe(500 - 2 - 12);
  });
});
