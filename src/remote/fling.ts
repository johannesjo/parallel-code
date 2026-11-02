// Velocity keeps this share per millisecond: a fast flick coasts about a screen, as native scrolling does.
const FRICTION = 0.997;
// A finger that rests this long before lifting meant to stop, not to throw.
const RELEASE_WINDOW_MS = 100;
// px/ms; slower than this is a placed finger, not a flick.
const MIN_SPEED = 0.1;
const STOP_SPEED = 0.02;

/**
 * Coast a custom touch scroll after the finger lifts. Panes that take over
 * touchmove to scroll lose the browser's own momentum, so swipes otherwise
 * stop dead. Not gated on reduced motion: like native scrolling, the coast
 * continues the user's own gesture rather than animating a change.
 */
export function createFling(scroll: (dx: number, dy: number) => void) {
  let vx = 0;
  let vy = 0;
  let movedAt = 0;
  let frame = 0;

  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    vx = 0;
    vy = 0;
    movedAt = 0;
  };

  /** Record a finger move of (dx, dy) pixels in the scroll direction. */
  const track = (dx: number, dy: number) => {
    const now = performance.now();
    const dt = Math.max(1, now - movedAt);
    // The speed at release sets the coast, so the latest move outweighs the swipe's average.
    const weight = movedAt && dt < RELEASE_WINDOW_MS ? 0.8 : 1;
    vx = weight * (dx / dt) + (1 - weight) * vx;
    vy = weight * (dy / dt) + (1 - weight) * vy;
    movedAt = now;
  };

  const release = () => {
    const resting = performance.now() - movedAt > RELEASE_WINDOW_MS;
    if (!movedAt || resting || Math.hypot(vx, vy) < MIN_SPEED) {
      stop();
      return;
    }
    let last = 0;
    const step = (now: number) => {
      // Cap the step so a stalled frame does not jump the pane.
      const dt = last ? Math.min(32, now - last) : 16;
      last = now;
      scroll(vx * dt, vy * dt);
      const decay = FRICTION ** dt;
      vx *= decay;
      vy *= decay;
      frame = Math.hypot(vx, vy) > STOP_SPEED ? requestAnimationFrame(step) : 0;
    };
    frame = requestAnimationFrame(step);
  };

  return { track, release, stop };
}
