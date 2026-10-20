import { MAX_TOUR_DEPTH, nodeTrail, type TourNode } from './tour-tree';
import type { TourCard } from './understanding-tour';

/**
 * Edits for a tour the reader writes themselves. Each returns a new tree and
 * copies only the path to the change, so untouched nodes keep their identity
 * and the views keyed on them don't re-render. Unknown ids and moves the tree
 * can't take return the input unchanged.
 */

type ListEdit = (siblings: readonly TourNode[], index: number) => TourNode[] | undefined;

/** The list holding `id` after `edit`, rebuilt up to the roots; undefined when nothing changed. */
function applyEdit(list: readonly TourNode[], id: string, edit: ListEdit): TourNode[] | undefined {
  const index = list.findIndex((node) => node.id === id);
  if (index >= 0) return edit(list, index);
  for (let at = 0; at < list.length; at += 1) {
    const children = applyEdit(list[at].children, id, edit);
    if (children) return splice(list, at, 1, { ...list[at], children });
  }
  return undefined;
}

function editSiblings(roots: readonly TourNode[], id: string, edit: ListEdit): TourNode[] {
  return applyEdit(roots, id, edit) ?? [...roots];
}

function splice(
  list: readonly TourNode[],
  start: number,
  remove: number,
  ...items: TourNode[]
): TourNode[] {
  return [...list.slice(0, start), ...items, ...list.slice(start + remove)];
}

export function replaceCard(roots: readonly TourNode[], id: string, card: TourCard): TourNode[] {
  return editSiblings(roots, id, (siblings, index) =>
    splice(siblings, index, 1, { ...siblings[index], card }),
  );
}

export function insertAfter(roots: readonly TourNode[], id: string, node: TourNode): TourNode[] {
  return editSiblings(roots, id, (siblings, index) => splice(siblings, index + 1, 0, node));
}

/** Adds `node` as the last follow-up of `id`, unless that would nest too deep. */
export function insertChild(roots: readonly TourNode[], id: string, node: TourNode): TourNode[] {
  if (nodeTrail(roots, id).length >= MAX_TOUR_DEPTH) return [...roots];
  return editSiblings(roots, id, (siblings, index) => {
    const parent = siblings[index];
    return splice(siblings, index, 1, { ...parent, children: [...parent.children, node] });
  });
}

/** Moves the card out to sit right after its parent; its later siblings stay put. */
export function outdent(roots: readonly TourNode[], id: string): TourNode[] {
  const trail = nodeTrail(roots, id);
  const node = trail[trail.length - 1];
  const parent = trail[trail.length - 2];
  if (!node || !parent) return [...roots];
  const without = editSiblings(roots, id, (siblings, index) => splice(siblings, index, 1));
  return insertAfter(without, parent.id, node);
}

/** Removes the card; its follow-ups take its place so nothing written is lost. */
export function removeNode(roots: readonly TourNode[], id: string): TourNode[] {
  return editSiblings(roots, id, (siblings, index) =>
    splice(siblings, index, 1, ...siblings[index].children),
  );
}

/** A card the reader has yet to write. */
export function blankCard(): TourCard {
  return { label: '', title: '', body: '', tone: 'neutral', refs: [] };
}

export function isBlankCard(card: TourCard): boolean {
  return !card.title.trim() && !card.body.trim() && !card.points?.some((point) => point.trim());
}

/** Whether any card of the tree has something written on it. */
export function hasWriting(roots: readonly TourNode[]): boolean {
  return roots.some((node) => !isBlankCard(node.card) || hasWriting(node.children));
}

/**
 * Takes a written card in place of the reader's notes: the first card replaces
 * the one written on, the rest become its follow-ups, or the cards after it
 * where the tour can nest no deeper.
 */
export function applyWrittenCards(
  roots: readonly TourNode[],
  id: string,
  options: { cards: readonly TourCard[]; nextId: () => string },
): TourNode[] {
  const [first, ...rest] = options.cards;
  if (!first) return [...roots];
  const nested = nodeTrail(roots, id).length < MAX_TOUR_DEPTH;
  const nodes = rest.map((card): TourNode => ({ id: options.nextId(), card, children: [] }));
  let next = replaceCard(roots, id, first);
  // Reversed, as siblings each go in right after the card written on.
  for (const node of nested ? nodes : [...nodes].reverse())
    next = nested ? insertChild(next, id, node) : insertAfter(next, id, node);
  return next;
}

/**
 * A card's text as the reader edits it: the body, then any points as a
 * Markdown list. Written cards keep points apart so they read as a slide.
 */
export function editableText(card: TourCard): string {
  const points = (card.points ?? []).map((point) => `- ${point}`).join('\n');
  return [card.body, points].filter(Boolean).join('\n\n');
}

/** The card with the reader's text; unchanged text keeps its points as they were. */
export function withText(card: TourCard, text: string): TourCard {
  if (text === editableText(card)) return card;
  const { points: _points, ...rest } = card;
  return { ...rest, body: text };
}
