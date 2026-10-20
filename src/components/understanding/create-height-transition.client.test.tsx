import { createRoot } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHeightTransition } from './create-height-transition';

interface FakeAnimation {
  keyframes: Keyframe[];
  end: () => void;
  cancel: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
}

let report: () => void = () => {};
let disconnect = vi.fn();
let reducedMotion = false;

function setup() {
  const element = document.createElement('div');
  let height = 300;
  const animations: FakeAnimation[] = [];
  element.getBoundingClientRect = () => ({ height }) as DOMRect;
  element.animate = ((keyframes: Keyframe[]) => {
    const target = new EventTarget();
    const end = () => target.dispatchEvent(new Event('finish'));
    const cancel = vi.fn(() => target.dispatchEvent(new Event('cancel')));
    const finish = vi.fn(end);
    animations.push({ keyframes, end, cancel, finish });
    return Object.assign(target, { cancel, finish });
  }) as unknown as HTMLElement['animate'];
  const { dispose, settle } = createRoot((dispose) => ({
    dispose,
    settle: createHeightTransition(element),
  }));
  const resize = (next: number) => {
    height = next;
    report();
  };
  report();
  return { element, animations, resize, dispose, settle };
}

describe('createHeightTransition', () => {
  beforeEach(() => {
    reducedMotion = false;
    disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnect = disconnect;
        constructor(callback: ResizeObserverCallback) {
          report = () => callback([], this as never);
        }
        observe() {}
        unobserve() {}
      },
    );
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return reducedMotion;
      },
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('eases from the old height to the new one', () => {
    const { element, animations, resize } = setup();
    expect(animations).toHaveLength(0);

    resize(420);

    expect(animations.map((a) => a.keyframes)).toEqual([
      [{ height: '300px' }, { height: '420px' }],
    ]);
    expect(element.dataset.resizing).toBe('');
    animations[0]?.end();
    expect(element.dataset.resizing).toBeUndefined();
  });

  it('carries on to a height that changed while it eased', () => {
    const { animations, resize } = setup();
    resize(420);
    resize(380);
    resize(500);
    expect(animations).toHaveLength(1);

    animations[0]?.end();
    resize(500);

    expect(animations[1]?.keyframes).toEqual([{ height: '420px' }, { height: '500px' }]);
  });

  it('snaps when the reader asks for less motion or the window resizes', () => {
    const { animations, resize } = setup();
    reducedMotion = true;
    resize(420);
    reducedMotion = false;
    window.dispatchEvent(new Event('resize'));
    resize(300);

    expect(animations).toHaveLength(0);
  });

  it('ends a running ease on request, so the settled layout can be measured', () => {
    const { element, animations, resize, settle } = setup();
    settle();
    resize(420);

    settle();

    expect(animations[0]?.finish).toHaveBeenCalled();
    expect(element.dataset.resizing).toBeUndefined();
  });

  it('stops observing and easing when its owner goes', () => {
    const { animations, resize, dispose } = setup();
    resize(420);

    dispose();

    expect(disconnect).toHaveBeenCalled();
    expect(animations[0]?.cancel).toHaveBeenCalled();
  });
});
