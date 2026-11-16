import { produce, unwrap } from 'solid-js/store';
import { defaultCards } from '../lib/app-facts';
import { CONFIDENCE_CARD_ID } from '../../electron/shared/card-publish';
import { CARD_LIMITS, type CardDefinition } from '../lib/cards';
import { store, setStore } from './core';

/** Whether a card runs and shows in a project: the master switch, then the project override. */
export function isCardEnabled(card: CardDefinition, projectId: string): boolean {
  if (!store.showCards) return false;
  return card.projects?.[projectId] ?? card.enabled;
}

/** Cards enabled in a project, in display order. */
export function enabledCards(projectId: string): CardDefinition[] {
  return store.cardDefinitions.filter((card) => isCardEnabled(card, projectId));
}

/**
 * Model calls one settled turn of a task can cost: one per card a model fills
 * after each turn, in the project running the most, and only when something changed.
 */
export function modelCallsPerTurn(): number {
  const afterTurn = store.cardDefinitions.filter(
    (card) => card.source.kind === 'model' && card.source.trigger === 'after-turn',
  );
  const perProject = store.projects.map(
    (project) => afterTurn.filter((card) => isCardEnabled(card, project.id)).length,
  );
  // No project yet: the global defaults are what the first one will get.
  const fallback = store.showCards ? afterTurn.filter((card) => card.enabled).length : 0;
  return perProject.length ? Math.max(...perProject) : fallback;
}

export function setShowCards(shown: boolean): void {
  setStore('showCards', shown);
}

function updateCard(cardId: string, update: (card: CardDefinition) => void): void {
  setStore(
    produce((s) => {
      const card = s.cardDefinitions.find((entry) => entry.id === cardId);
      if (card) update(card);
    }),
  );
}

/** Sets a card's global on/off. */
export function setCardEnabled(cardId: string, enabled: boolean): void {
  updateCard(cardId, (card) => {
    card.enabled = enabled;
  });
}

/**
 * Adds a card at the end of the display order; false when its id is taken or
 * reserved, or the cap (Confidence included) is reached.
 */
export function addCard(card: CardDefinition): boolean {
  // Restore keeps only the first CARD_LIMITS.cards, so a card past it would vanish on relaunch.
  if (store.cardDefinitions.length >= CARD_LIMITS.cards) return false;
  // Restore turns any card with this id into the built-in one.
  if (card.id === CONFIDENCE_CARD_ID) return false;
  if (store.cardDefinitions.some((entry) => entry.id === card.id)) return false;
  setStore('cardDefinitions', (cards) => [...cards, card]);
  return true;
}

/**
 * Replaces a card's definition, keeping its place. Stored values of slots the
 * new layout no longer has are dropped from every task.
 */
export function saveCard(next: CardDefinition): void {
  const kept = new Set(next.slots.map((slot) => slot.id));
  setStore(
    produce((s) => {
      const index = s.cardDefinitions.findIndex((card) => card.id === next.id);
      if (index < 0) return;
      s.cardDefinitions[index] = structuredClone(unwrap(next));
      for (const task of Object.values(s.tasks)) {
        const stored = task.cards?.[next.id];
        if (!stored) continue;
        for (const slotId of Object.keys(stored.values))
          if (!kept.has(slotId)) delete stored.values[slotId];
      }
    }),
  );
}

/**
 * Removes a card and the values it left on tasks, so a later card that gets
 * the same id starts empty.
 */
export function removeCard(cardId: string): void {
  setStore(
    produce((s) => {
      s.cardDefinitions = s.cardDefinitions.filter((card) => card.id !== cardId);
      for (const task of Object.values(s.tasks)) delete task.cards?.[cardId];
    }),
  );
}

/** Moves a card to `index` in the display order. */
export function moveCard(cardId: string, index: number): void {
  setStore(
    produce((s) => {
      const from = s.cardDefinitions.findIndex((card) => card.id === cardId);
      if (from < 0) return;
      const [card] = s.cardDefinitions.splice(from, 1);
      const to = Math.max(0, Math.min(index, s.cardDefinitions.length));
      s.cardDefinitions.splice(to, 0, card);
    }),
  );
}

/** Pins or unpins one of a card's slots in the pin row. */
export function setSlotPinned(cardId: string, slotId: string, pinned: boolean): void {
  updateCard(cardId, (card) => {
    const rest = (card.pinned ?? []).filter((id) => id !== slotId);
    const next = pinned ? [...rest, slotId] : rest;
    if (next.length) card.pinned = next;
    else delete card.pinned;
  });
}

/** Shows or hides a card's mini view in the pin row. */
export function setCardMini(cardId: string, mini: boolean): void {
  updateCard(cardId, (card) => {
    if (mini) card.mini = true;
    else delete card.mini;
  });
}

/** Answers the one-time offer of the free cards; turning them on switches each on globally. */
export function answerCardsOffer(turnOn: boolean): void {
  setStore(
    produce((s) => {
      s.cardsOfferPending = false;
      if (!turnOn) return;
      const free = new Set(defaultCards(true).map((card) => card.id));
      for (const card of s.cardDefinitions) if (free.has(card.id)) card.enabled = true;
    }),
  );
}
