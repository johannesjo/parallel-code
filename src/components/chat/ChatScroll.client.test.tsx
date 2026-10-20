import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatScroll } from './ChatScroll';

// happy-dom has no layout, so the log's geometry is faked: a 300px viewport over
// `height` px of content, with scrollTop clamped the way a browser clamps it.
let height = 1000;
let top = 0;
let resized: () => void;
let hold: () => void;
let container: HTMLDivElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  height = 1000;
  top = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  container = document.createElement('div');
  document.body.append(container);
  dispose = render(
    () => <ChatScroll onControls={(controls) => (hold = controls.hold)}>log</ChatScroll>,
    container,
  );
  const log = scroller();
  Object.defineProperty(log, 'scrollHeight', { get: () => height });
  Object.defineProperty(log, 'clientHeight', { get: () => 300 });
  Object.defineProperty(log, 'scrollTop', {
    get: () => top,
    set: (value: number) => (top = Math.max(0, Math.min(value, height - 300))),
  });
  resized();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

const scroller = () => container.querySelector<HTMLElement>('.chat-scroll') as HTMLElement;
const jumpButton = () => container.querySelector('.chat-jump');
/** New output lands; the observer reacts before the next paint. */
function grow(by: number) {
  height += by;
  resized();
}
/** A scroll event reporting wherever the log is now, as the browser delivers it. */
function scrolled(to = top) {
  top = to;
  scroller().dispatchEvent(new Event('scroll'));
}

it('keeps following when output lands between its own scroll and that scroll event', () => {
  expect(top).toBe(700);
  // The event for the scroll to 700 arrives only after another 200px streamed in.
  height += 200;
  scrolled();
  grow(0);
  expect(top).toBe(900);
  expect(jumpButton()).toBeNull();
});

it('stops following once the reader scrolls up, and resumes at the bottom', () => {
  scroller().dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
  // A smooth scroll starts close to the bottom; it must not count as coming back.
  scrolled(690);
  grow(200);
  expect(top).toBe(690);
  expect(jumpButton()).not.toBeNull();
  scrolled(900);
  grow(100);
  expect(top).toBe(1000);
  expect(jumpButton()).toBeNull();
});

it('keeps following after a click that leaves the log at the bottom', () => {
  scroller().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointerup'));
  grow(200);
  expect(top).toBe(900);
});

it('holds the view when a click expands something in the log', () => {
  scroller().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  height += 400; // a disclosure opens on click, before the next frame
  window.dispatchEvent(new PointerEvent('pointerup'));
  resized();
  expect(top).toBe(700);
  expect(jumpButton()).not.toBeNull();
});

it('holds the view where a search jump puts it while the matching entry opens', () => {
  hold();
  scrolled(200);
  grow(400);
  expect(top).toBe(200);
  expect(jumpButton()).not.toBeNull();
});

it('leaves a touch that turned into a scroll to its own scroll events', () => {
  scroller().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointercancel'));
  // The finger is dragging the log up; output landing now must not pull it back.
  grow(200);
  expect(top).toBe(700);
  scrolled(900);
  grow(100);
  expect(top).toBe(1000);
});
