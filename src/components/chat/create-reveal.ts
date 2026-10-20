import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';

/** Animate display text only. History and clipboard content keep the received text. */
export function createReveal(text: () => string, running: () => boolean): () => string {
  const [visible, setVisible] = createSignal(untrack(text));
  let shown = untrack(text);
  createEffect(() => {
    const full = text();
    const live = running();
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const flush = () => {
      cancelAnimationFrame(frame);
      shown = full;
      setVisible(full);
    };
    if (!live || motion.matches || !full.startsWith(shown)) {
      flush();
      return;
    }
    let last = performance.now();
    const tick = (now: number) => {
      const rest = Array.from(full.slice(shown.length));
      const count = Math.min(
        rest.length,
        Math.floor((now - last) / Math.min(5, 250 / Math.max(1, rest.length))),
      );
      if (count > 0) {
        shown += rest.slice(0, count).join('');
        last = now;
        setVisible(shown);
      }
      if (shown !== full) frame = requestAnimationFrame(tick);
    };
    const onMotion = () => {
      if (motion.matches) flush();
    };
    frame = requestAnimationFrame(tick);
    motion.addEventListener('change', onMotion);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      motion.removeEventListener('change', onMotion);
    });
  });
  // eslint-disable-next-line solid/reactivity -- an accessor, read in the caller's tracked scope
  return () => (running() && text().startsWith(visible()) ? visible() : text());
}
