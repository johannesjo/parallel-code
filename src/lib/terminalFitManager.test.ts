import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ResizeObserverCallback = (entries: Array<{ target: unknown }>) => void;

let resizeCallback: ResizeObserverCallback | undefined;

class FakeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }
  observe = vi.fn();
  unobserve = vi.fn();
}

class FakeIntersectionObserver {
  constructor(_callback: unknown) {}
  observe = vi.fn();
  unobserve = vi.fn();
}

function makeContainer(width: number, height: number): HTMLElement {
  const container = {
    offsetWidth: width,
    offsetHeight: height,
    contains: (node: unknown) => node === container,
  } as HTMLElement;
  return container;
}

describe('terminalFitManager', () => {
  beforeEach(() => {
    vi.resetModules();
    resizeCallback = undefined;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal('performance', { now: () => 10_000 });
    vi.stubGlobal('window', {
      setTimeout: (cb: () => void) => {
        cb();
        return 0;
      },
      clearTimeout: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not fit a terminal while its container is collapsed to zero size', async () => {
    const { registerTerminal } = await import('./terminalFitManager');
    const container = makeContainer(0, 0);
    const fitAddon = { fit: vi.fn() };

    registerTerminal('agent-1', container, fitAddon as never, {
      buffer: { active: { viewportY: 0, baseY: 0 } },
      scrollToLine: vi.fn(),
    } as never);

    resizeCallback?.([{ target: container }]);

    expect(fitAddon.fit).not.toHaveBeenCalled();
  });
});
