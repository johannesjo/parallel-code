import { onCleanup } from 'solid-js';

const DURATION_MS = 180;
/** Heights reported this soon after a window resize follow the drag, unanimated. */
const RESIZE_SETTLE_MS = 100;

/**
 * Eases `element` to each new height its content gives it, so a taller or
 * shorter card grows or shrinks instead of snapping. Call it in the element's
 * owner; it stops when that owner is disposed. Returns a function that ends
 * a running ease at once, for code that must measure the settled layout.
 */
export function createHeightTransition(element: HTMLElement): () => void {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let shown: number | undefined;
  let resizedAt = -Infinity;
  let running: Animation | undefined;
  const onResize = () => (resizedAt = performance.now());
  // Resize callbacks run after layout and before paint, so the new height is
  // never painted before the ease starts from the old one.
  const observer = new ResizeObserver(() => {
    // Sizes reported mid-ease are the animation's own frames; once it ends, a
    // height that changed meanwhile is reported again and eased to in turn.
    if (running) return;
    const from = shown;
    shown = element.getBoundingClientRect().height;
    // A window resize moves the height cap and rewraps the text; easing that
    // would lag the drag.
    const resizing = performance.now() - resizedAt < RESIZE_SETTLE_MS;
    if (from === undefined || from === shown || resizing || motion.matches) return;
    element.dataset.resizing = '';
    const animation = element.animate([{ height: `${from}px` }, { height: `${shown}px` }], {
      duration: DURATION_MS,
      easing: 'ease-out',
    });
    const settle = () => {
      running = undefined;
      delete element.dataset.resizing;
    };
    animation.addEventListener('finish', settle);
    animation.addEventListener('cancel', settle);
    running = animation;
  });
  observer.observe(element);
  addEventListener('resize', onResize);
  onCleanup(() => {
    observer.disconnect();
    removeEventListener('resize', onResize);
    running?.cancel();
  });
  return () => running?.finish();
}
