import { createEffect } from 'solid-js';

/**
 * Plays the brief highlight on `el` (`[data-flash]` in cards.css). A newer change
 * restarts it instead of queueing behind the running one.
 */
export function flash(el: HTMLElement): void {
  el.removeAttribute('data-flash');
  // Reading layout commits the removal, so setting the attribute again restarts the animation.
  void el.offsetWidth;
  el.setAttribute('data-flash', '');
  // Children animate too (spinners); only the highlight's own end clears it.
  el.onanimationend = (event) => {
    if (event.target === el) el.removeAttribute('data-flash');
  };
}

/**
 * Highlights `el` whenever `key` changes after its first read, so a value swapped
 * while it is in view gets noticed. An empty key means no value: nothing to point at.
 */
export function createFlashOnChange(el: () => HTMLElement | undefined, key: () => string): void {
  // Seeded by the first run: `on` with `defer` would pass no previous key to the first change.
  createEffect((prev: string | undefined) => {
    const next = key();
    const target = el();
    if (prev !== undefined && target && next && next !== prev) flash(target);
    return next;
  });
}

/**
 * Brings a shown card into view, focuses it and points it out, so the eye lands on
 * the card a pinned value belongs to. A card that is not shown (hidden while empty) is left alone.
 */
export function revealCard(container: ParentNode | undefined, cardId: string): void {
  // Card ids are [a-z0-9-] (`freeCardId`), so they need no escaping in the selector.
  const card = container?.querySelector<HTMLElement>(`.card[data-card-id="${cardId}"]`);
  if (!card) return;
  card.scrollIntoView({ block: 'nearest' });
  card.focus({ preventScroll: true });
  flash(card);
}
