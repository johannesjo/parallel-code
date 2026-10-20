/**
 * What an overlay that floats over the window needs: to be placed from its
 * anchor's on-screen position and to survive the pointer's trip from the
 * anchor to the overlay itself. Anchors sit in scroll containers and, on
 * HTML pages, inside elements whose own CSS clips overflow, so the overlay
 * lives in `document.body` with `position: fixed` and is placed by hand.
 */
import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';

/**
 * Runs `place` when `active` turns on, whenever the signals it reads change,
 * and again on every scroll anywhere and on resize, until `active` turns off.
 */
export function createAnchorEffect(active: Accessor<boolean>, place: () => void): void {
  createEffect(() => {
    if (!active()) return;
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    onCleanup(() => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    });
  });
}

export interface Viewport {
  width: number;
  height: number;
}

export interface BelowAnchor {
  top: number;
  right: number;
  /** Room left between the overlay's top and the viewport's bottom edge. */
  maxHeight: number;
}

/** Breathing room between the anchor and the overlay. */
const GAP = 2;

/**
 * Flush under `anchor` and right-aligned with it, kept `edge` px inside the
 * viewport: an anchor at the window's edge does not push the overlay off it.
 * Given the overlay's `height`, an anchor too close to the bottom for it gets
 * the overlay above instead, when there is more room there.
 */
export function placeBelow(
  anchor: { top?: number; right: number; bottom: number },
  width: number,
  viewport: Viewport,
  edge = 12,
  height?: number,
): BelowAnchor {
  const right = Math.min(
    Math.max(viewport.width - anchor.right, edge),
    viewport.width - width - edge,
  );
  const below = viewport.height - anchor.bottom - GAP - edge;
  const above = anchor.top === undefined ? 0 : anchor.top - GAP - edge;
  if (height !== undefined && height > below && above > below) {
    const top = Math.max(edge, (anchor.top ?? 0) - GAP - height);
    return { top, right, maxHeight: Math.max(120, above) };
  }
  const top = anchor.bottom + GAP;
  return { top, right, maxHeight: Math.max(120, below) };
}

export interface HeldSignal<T> {
  value: Accessor<T | null>;
  /** Takes effect at once and cancels a pending clear. */
  set: (value: T) => void;
  /** Cancels a pending clear without changing the value. */
  hold: () => void;
  /** Empties the value after `delayMs`, unless `set` or `hold` comes first. */
  clear: () => void;
}

/**
 * A value that changes at once but empties only after a delay: the beat that
 * lets a pointer cross from an anchor to the overlay it opened without the
 * overlay closing under it.
 */
export function createHeldSignal<T>(delayMs: number): HeldSignal<T> {
  const [value, setValue] = createSignal<T | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hold = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  onCleanup(hold);
  return {
    value,
    hold,
    set: (next) => {
      hold();
      setValue(() => next);
    },
    clear: () => {
      hold();
      timer = setTimeout(() => {
        timer = undefined;
        setValue(null);
      }, delayMs);
    },
  };
}
