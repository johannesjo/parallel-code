import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let manager: typeof import('./terminalFitManager');
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let reportIntersection: (target: Element, isIntersecting: boolean) => void;
let reportResize: (target: Element) => void;

function frame() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(performance.now());
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        reportIntersection = (target, isIntersecting) =>
          callback(
            [{ target, isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      observe() {}
      unobserve() {}
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        reportResize = (target) =>
          callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      observe() {}
      unobserve() {}
    },
  );
  manager = await import('./terminalFitManager');
});

afterEach(() => {
  manager.unregisterTerminal('test');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function terminal(viewportY = 5, rowChange = -6) {
  const buffer = { viewportY, baseY: 100 };
  let scrollbarY = viewportY;
  const container = document.createElement('div');
  const term = {
    rows: 20,
    cols: 80,
    buffer: { active: buffer },
    scrollToLine(line: number) {
      // xterm applies the buffer-relative delta to its scrollbar, whose
      // position is not synchronized with resized rows until the next render.
      scrollbarY = Math.max(0, scrollbarY + line - buffer.viewportY);
      buffer.viewportY = scrollbarY;
    },
  };
  const addon = {
    fit() {
      term.rows += rowChange;
      buffer.baseY -= rowChange;
      buffer.viewportY = Math.max(0, buffer.viewportY - rowChange);
      requestAnimationFrame(() => {
        scrollbarY = buffer.viewportY;
      });
    },
  };
  manager.registerTerminal('test', container, addon as FitAddon, term as Terminal);
  manager.markDirty('test');
  vi.advanceTimersByTime(150);
  frame();
  return { buffer, container, term, addon };
}

describe('terminal resize scroll position', () => {
  it.each([
    [5, -6],
    [50, -6],
    [50, 6],
  ])('keeps history at line %i when the row count changes by %i', (line, rowChange) => {
    const { buffer } = terminal(line, rowChange);
    expect(buffer.viewportY).toBe(line);
    frame();
    expect(buffer.viewportY).toBe(line);
  });

  it('leaves terminals following live output at the new bottom', () => {
    const { buffer } = terminal(100);
    frame();
    expect(buffer.viewportY).toBe(buffer.baseY);
  });
});

describe('terminal unregistration', () => {
  it('cancels pending fits once the last terminal is gone', () => {
    const container = document.createElement('div');
    const fit = vi.fn();
    const term = { buffer: { active: { viewportY: 0, baseY: 0 } } };
    manager.registerTerminal('test', container, { fit } as unknown as FitAddon, term as Terminal);
    manager.markDirty('test');
    manager.unregisterTerminal('test');

    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
  });
});

describe('deferred resizes', () => {
  function longTerminal() {
    const container = document.createElement('div');
    const term = {
      rows: 20,
      cols: 80,
      buffer: { active: { viewportY: 0, baseY: 0 }, normal: { length: 1000 } },
      resize: vi.fn((cols: number, rows: number) => {
        term.cols = cols;
        term.rows = rows;
      }),
      scrollToLine: vi.fn(),
    };
    const addon = {
      proposeDimensions: () => ({ cols: 100, rows: 30 }),
      fit: vi.fn(() => term.resize(100, 30)),
    };
    manager.registerTerminal(
      'test',
      container,
      addon as unknown as FitAddon,
      term as unknown as Terminal,
    );
    return { container, term, addon };
  }

  it('applies rows at once but reflows columns only once resizing settles', () => {
    const { container, term, addon } = longTerminal();
    vi.advanceTimersByTime(150);
    reportResize(container);
    frame();
    expect(addon.fit).not.toHaveBeenCalled();
    expect(term).toMatchObject({ cols: 80, rows: 30 });

    vi.advanceTimersByTime(150);
    frame();
    expect(addon.fit).toHaveBeenCalledTimes(1);
    expect(term).toMatchObject({ cols: 100, rows: 30 });
  });

  it('fits in full on the next frame when asked to directly', () => {
    const { addon } = longTerminal();
    vi.advanceTimersByTime(150);
    manager.markDirty('test');
    frame();
    expect(addon.fit).toHaveBeenCalledTimes(1);
  });

  it('fits a pane in full as soon as it comes into view', () => {
    const { container, addon } = longTerminal();
    reportIntersection(container, false);
    reportResize(container);
    vi.advanceTimersByTime(150);
    frame();
    expect(addon.fit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);
    reportIntersection(container, true);
    frame();
    expect(addon.fit).toHaveBeenCalledTimes(1);
  });
});

describe('repainting terminals', () => {
  it('resets every terminal, since they share one glyph atlas', () => {
    const terms = ['repaint-a', 'repaint-b', 'repaint-c'].map((id) => {
      const term = {
        rows: 24,
        buffer: { active: { viewportY: 0, baseY: 0 } },
        clearTextureAtlas: vi.fn(),
        refresh: vi.fn(),
      };
      manager.registerTerminal(
        id,
        document.createElement('div'),
        { fit() {} } as unknown as FitAddon,
        term as unknown as Terminal,
      );
      return { id, term };
    });
    // A terminal torn down mid-repaint must not stop the others.
    terms[1].term.clearTextureAtlas.mockImplementation(() => {
      throw new Error('disposed');
    });

    manager.redrawAllTerminals();

    for (const { id, term } of terms) {
      expect(term.clearTextureAtlas).toHaveBeenCalledTimes(1);
      if (id !== 'repaint-b') expect(term.refresh).toHaveBeenCalledWith(0, 23);
      manager.unregisterTerminal(id);
    }
  });
});
