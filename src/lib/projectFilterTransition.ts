import { createEffect, on, onCleanup, type Accessor } from 'solid-js';
import { EASE_OUT, prefersMotion } from './reducedMotion';

/** Fade the settled layout, never animate terminal widths or remount sessions. */
export function createProjectFilterTransition(
  filter: Accessor<string | null>,
  element: Accessor<HTMLElement | undefined>,
): void {
  createEffect(
    on(
      filter,
      () => {
        if (!prefersMotion()) return;
        let animation: Animation | undefined;
        const frame = requestAnimationFrame(() => {
          animation = element()?.animate?.([{ opacity: 0.45 }, { opacity: 1 }], {
            duration: 160,
            easing: EASE_OUT,
          });
        });
        onCleanup(() => {
          cancelAnimationFrame(frame);
          animation?.cancel();
        });
      },
      { defer: true },
    ),
  );
}
