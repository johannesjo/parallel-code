import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';

/** How long a task must stay active before its git checks start. Holding
 *  Alt+Arrow passes through tasks faster than this, so the ones skipped over
 *  spawn no git processes. */
export const ACTIVE_TASK_SETTLE_MS = 60;

/**
 * Follows `source`, but turns true only after it has stayed true for
 * `delayMs`. It turns false immediately, so work it gates stops right away.
 */
export function createSettledFlag(source: Accessor<boolean>, delayMs: number): Accessor<boolean> {
  const [settled, setSettled] = createSignal(source());
  createEffect(() => {
    if (!source()) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), delayMs);
    onCleanup(() => clearTimeout(timer));
  });
  return settled;
}
