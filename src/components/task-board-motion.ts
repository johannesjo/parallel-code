import { createComputed, createEffect, on } from 'solid-js';
import { EASE_OUT, prefersMotion } from '../lib/reducedMotion';

type Point = { left: number; top: number };

export interface CardMotionPlan {
  /** Cards that stayed, with how far each moved; only those that moved. */
  moved: { id: string; dx: number; dy: number }[];
  added: string[];
  removed: string[];
}

/** Compares two layouts of cards, keyed by card id. Sub-pixel shifts don't count as moves. */
export function planCardMotion(
  before: ReadonlyMap<string, Point>,
  after: ReadonlyMap<string, Point>,
): CardMotionPlan {
  const plan: CardMotionPlan = { moved: [], added: [], removed: [] };
  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was) {
      plan.added.push(id);
      continue;
    }
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) plan.moved.push({ id, dx, dy });
  }
  for (const id of before.keys()) if (!after.has(id)) plan.removed.push(id);
  return plan;
}

const MOVE_MS = 220;
const FADE_MS = 160;

type Card = { el: HTMLElement; rect: DOMRect };

// Ideas animate like cards but keep their own marker: they aren't tasks to the keyboard.
const ANIMATED = '[data-board-card], [data-board-idea]';

function measureCards(container: HTMLElement): Map<string, Card> {
  const cards = new Map<string, Card>();
  for (const el of container.querySelectorAll<HTMLElement>(ANIMATED)) {
    const id = el.dataset.boardCard ?? el.dataset.boardIdea;
    if (id) cards.set(id, { el, rect: el.getBoundingClientRect() });
  }
  return cards;
}

const toPoints = (cards: Map<string, Card>): Map<string, Point> =>
  new Map([...cards].map(([id, { rect }]) => [id, { left: rect.left, top: rect.top }]));

/** Leaves a removed card where it stood, fading, above the cards that close the gap. */
function fadeOutGhost(container: HTMLElement, card: Card): void {
  const box = container.getBoundingClientRect();
  const ghost = card.el;
  // No longer a card: keyboard and card lookups must not find it.
  delete ghost.dataset.boardCard;
  delete ghost.dataset.boardTaskId;
  delete ghost.dataset.boardIdea;
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  Object.assign(ghost.style, {
    position: 'absolute',
    left: `${card.rect.left - box.left + container.scrollLeft - container.clientLeft}px`,
    top: `${card.rect.top - box.top + container.scrollTop - container.clientTop}px`,
    width: `${card.rect.width}px`,
    height: `${card.rect.height}px`,
    margin: '0',
    pointerEvents: 'none',
  });
  container.append(ghost);
  ghost
    .animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.97)' }], {
      duration: FADE_MS,
      easing: EASE_OUT,
      fill: 'forwards',
    })
    .finished.then(
      () => ghost.remove(),
      () => ghost.remove(),
    );
}

/**
 * Animates the board's cards between layouts (FLIP): a card that changes lane
 * or place glides from where it was, a new card fades in, and a removed one
 * fades out where it stood. `layout` is the data the cards render from; the
 * cards are measured before Solid applies a change to it and animated after.
 */
export function useCardMotion(container: () => HTMLElement | undefined, layout: () => unknown) {
  let before: Map<string, Card> | undefined;
  const moving = new WeakMap<HTMLElement, Animation>();

  // Pure computations run before the render effects that update the DOM.
  createComputed(
    on(layout, () => {
      const root = container();
      before = root && prefersMotion() ? measureCards(root) : undefined;
    }),
  );

  createEffect(
    on(
      layout,
      () => {
        const root = container();
        const was = before;
        before = undefined;
        if (!root || !was || typeof root.animate !== 'function') return;
        // A card still gliding from the last change is measured where it will end.
        for (const el of root.querySelectorAll<HTMLElement>(ANIMATED)) {
          moving.get(el)?.cancel();
        }
        const after = measureCards(root);
        const plan = planCardMotion(toPoints(was), toPoints(after));
        for (const { id, dx, dy } of plan.moved) {
          const el = after.get(id)?.el;
          if (!el) continue;
          const keyframes = [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }];
          moving.set(el, el.animate(keyframes, { duration: MOVE_MS, easing: EASE_OUT }));
        }
        for (const id of plan.added) {
          after.get(id)?.el.animate([{ opacity: 0, transform: 'scale(0.97)' }, {}], {
            duration: FADE_MS,
            easing: EASE_OUT,
          });
        }
        for (const id of plan.removed) {
          const card = was.get(id);
          if (card && !card.el.isConnected) fadeOutGhost(root, card);
        }
      },
      { defer: true },
    ),
  );
}
