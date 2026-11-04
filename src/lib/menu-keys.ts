/**
 * Keyboard handling for a small `role="menu"` popup: arrows, Home and End move
 * between items, Escape and Tab close it. Attach as the menu's onKeyDown.
 */
export function handleMenuKeyDown(e: KeyboardEvent, close: () => void): void {
  const menu = e.currentTarget as HTMLElement;
  if (e.key === 'Escape') {
    // Marked handled so the global Escape (closeDialogs) skips this press.
    e.preventDefault();
    close();
    return;
  }
  if (e.key === 'Tab') {
    close();
    return;
  }
  const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])')];
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'ArrowDown'
      ? items[(at + 1) % items.length]
      : e.key === 'ArrowUp'
        ? items[(at - 1 + items.length) % items.length]
        : e.key === 'Home'
          ? items[0]
          : e.key === 'End'
            ? items[items.length - 1]
            : undefined;
  if (!next) return;
  e.preventDefault();
  next.focus();
}

/** Focuses a just-opened menu's first item, a frame later once it is laid out. */
export function focusFirstMenuItem(menu: HTMLElement): void {
  requestAnimationFrame(() =>
    menu.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')?.focus(),
  );
}
