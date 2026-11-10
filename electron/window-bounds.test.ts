import { describe, expect, it } from 'vitest';
import { initialWindowBounds, type Rect } from './window-bounds.js';

const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
const RIGHT: Rect = { x: 1920, y: 0, width: 2560, height: 1440 };
const DEFAULT = { width: 1400, height: 900 };

function state(windowState: unknown): string {
  return JSON.stringify({ projects: [], windowState });
}

describe('initialWindowBounds', () => {
  it('falls back to the default size when nothing is saved', () => {
    expect(initialWindowBounds(null, [PRIMARY])).toEqual({ bounds: DEFAULT, maximized: false });
    expect(initialWindowBounds(state(undefined), [PRIMARY])).toEqual({
      bounds: DEFAULT,
      maximized: false,
    });
  });

  it('restores saved bounds that lie on a connected display', () => {
    const saved = { x: 2000, y: 100, width: 1600, height: 1000, maximized: true };
    expect(initialWindowBounds(state(saved), [PRIMARY, RIGHT])).toEqual({
      bounds: { x: 2000, y: 100, width: 1600, height: 1000 },
      maximized: true,
    });
  });

  // The monitor the window was last on has been unplugged: keep the size but
  // let the OS place the window, rather than opening it where nobody can see it.
  it('drops the position when the saved bounds are off every display', () => {
    const saved = { x: 2000, y: 100, width: 1600, height: 1000, maximized: false };
    expect(initialWindowBounds(state(saved), [PRIMARY])).toEqual({
      bounds: { width: 1600, height: 1000 },
      maximized: false,
    });
  });

  it('drops the position when only a sliver of the window is on screen', () => {
    const saved = { x: 1900, y: 100, width: 1200, height: 800, maximized: false };
    expect(initialWindowBounds(state(saved), [PRIMARY]).bounds).toEqual({
      width: 1200,
      height: 800,
    });
  });

  it('ignores malformed or tiny saved state', () => {
    for (const bad of [
      { x: 0, y: 0, width: 50, height: 900, maximized: false },
      { x: 0, y: 0, width: '1400', height: 900, maximized: false },
      { x: 0, y: 0, width: 1400, height: 900 },
      'nope',
    ]) {
      expect(initialWindowBounds(state(bad), [PRIMARY])).toEqual({
        bounds: DEFAULT,
        maximized: false,
      });
    }
    expect(initialWindowBounds('{not json', [PRIMARY])).toEqual({
      bounds: DEFAULT,
      maximized: false,
    });
  });
});
