import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js';

/** Tracks the OS reduced-motion preference for the mounted component. */
export function createReducedMotion(): Accessor<boolean> {
  const [reducedMotion, setReducedMotion] = createSignal(false);
  onMount(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    onCleanup(() => media.removeEventListener('change', update));
  });
  return reducedMotion;
}
