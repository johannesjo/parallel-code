import { createSignal, onCleanup } from 'solid-js';

/** Open while the popover shows; closes on Escape or a click outside it. */
export function createPopover(
  anchor: () => HTMLElement | undefined,
  panel: () => HTMLElement | undefined,
) {
  const [open, setOpen] = createSignal(false);
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (target && (panel()?.contains(target) || anchor()?.contains(target))) return;
    setShown(false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setShown(false);
    anchor()?.focus();
  };
  // Listeners live only while open: a leftover keydown listener would swallow
  // Escape everywhere, terminals included.
  const setShown = (next: boolean) => {
    if (next === open()) return;
    setOpen(next);
    if (next) {
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      // Keyboard users land on the popover's controls.
      queueMicrotask(() => panel()?.querySelector<HTMLElement>('button')?.focus());
    } else {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    }
  };
  onCleanup(() => setShown(false));
  return { open, setShown };
}
