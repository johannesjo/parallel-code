import { createEffect, onCleanup } from 'solid-js';

/**
 * Reactive primitive that binds Arrow / Page / Home / End keys to scroll
 * a container element while a dialog is open.  Skips events originating
 * from input elements so typing isn't affected.
 */
export function createDialogScroll(
  getScrollEl: () => HTMLElement | undefined,
  isActive: () => boolean,
): void {
  createEffect(() => {
    if (!isActive()) return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const el = getScrollEl();
      if (!el) return;

      const step = 40;
      const page = Math.max(100, el.clientHeight - 40);
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          el.scrollTop += step;
          break;
        case 'ArrowUp':
          e.preventDefault();
          el.scrollTop -= step;
          break;
        case 'PageDown':
          e.preventDefault();
          el.scrollTop += page;
          break;
        case 'PageUp':
          e.preventDefault();
          el.scrollTop -= page;
          break;
        case 'Home':
          e.preventDefault();
          el.scrollTop = 0;
          break;
        case 'End':
          e.preventDefault();
          el.scrollTop = el.scrollHeight;
          break;
      }
    };
    document.addEventListener('keydown', handler);
    onCleanup(() => document.removeEventListener('keydown', handler));
  });
}
