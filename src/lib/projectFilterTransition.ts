import { createEffect, on, onCleanup, type Accessor } from 'solid-js';
import { shouldAnimateTaskAppearance } from './reducedMotion';

/** Fade the settled layout, never animate terminal widths or remount sessions. */
export function createProjectFilterTransition(
  filter: Accessor<string | null>,
  element: Accessor<HTMLElement | undefined>,
): void {
  createEffect(
    on(
      filter,
      () => {
        if (!shouldAnimateTaskAppearance()) return;
        let animation: Animation | undefined;
        const frame = requestAnimationFrame(() => {
          animation = element()?.animate?.([{ opacity: 0.45 }, { opacity: 1 }], {
            duration: 160,
            easing: 'ease-out',
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
