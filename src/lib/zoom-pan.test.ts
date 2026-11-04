import { describe, expect, it } from 'vitest';
import { FIT_VIEW, clampView, panBy, zoomAt } from './zoom-pan';

describe('zoomAt', () => {
  it('keeps the point under the cursor still', () => {
    const view = zoomAt(FIT_VIEW, 2, { x: 100, y: 50 });
    // The image point at 100,50 maps to (100 - x) / scale before and after.
    expect(view).toEqual({ scale: 2, x: -100, y: -50 });
    expect((100 - view.x) / view.scale).toBe(100);
  });

  it('stays between fit and eight times', () => {
    expect(zoomAt(FIT_VIEW, 0.5)).toEqual(FIT_VIEW);
    expect(zoomAt({ scale: 6, x: 0, y: 0 }, 4).scale).toBe(8);
  });

  it('recentres when zoomed back out to fit', () => {
    expect(zoomAt({ scale: 2, x: 40, y: -20 }, 0.25)).toEqual(FIT_VIEW);
  });
});

describe('panBy', () => {
  it('moves only a zoomed view', () => {
    expect(panBy(FIT_VIEW, 10, 10)).toEqual(FIT_VIEW);
    expect(panBy({ scale: 2, x: 0, y: 0 }, 10, -5)).toEqual({ scale: 2, x: 10, y: -5 });
  });
});

describe('clampView', () => {
  const bounds = { image: { width: 400, height: 200 }, stage: { width: 400, height: 300 } };

  it('stops the image edge at the stage edge', () => {
    // 2x: 800 wide in a 400 stage leaves 200 either way.
    expect(clampView({ scale: 2, x: 999, y: 0 }, bounds).x).toBe(200);
    expect(clampView({ scale: 2, x: -999, y: 0 }, bounds).x).toBe(-200);
  });

  it('centres an axis that still fits the stage', () => {
    // 1.25x: 250 high in a 300 stage cannot move vertically.
    expect(clampView({ scale: 1.25, x: 0, y: 80 }, bounds).y).toBe(0);
  });
});
