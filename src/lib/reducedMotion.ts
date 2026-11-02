import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js';

/** The app's easing curve for Web Animations; mirrors `--ease-out` in styles.css. */
export const EASE_OUT = 'cubic-bezier(0.2, 0, 0, 1)';

const QUERY = '(prefers-reduced-motion: reduce)';

/** Whether animations may run; false when the OS asks for reduced motion. */
export function prefersMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return !window.matchMedia(QUERY).matches;
}

/** Tracks the OS reduced-motion preference for the mounted component. */
export function createReducedMotion(): Accessor<boolean> {
  const [reducedMotion, setReducedMotion] = createSignal(false);
  onMount(() => {
    const media = window.matchMedia(QUERY);
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    onCleanup(() => media.removeEventListener('change', update));
  });
  return reducedMotion;
}
