import { afterEach, describe, expect, it } from 'vitest';
import { defaultCards } from '../lib/app-facts';
import { confidenceCard, persistCardDefinitions, type CardDefinition } from '../lib/cards';
import { setStore, store } from './core';
import {
  modelCallsPerTurn,
  addCard,
  answerCardsOffer,
  enabledCards,
  moveCard,
  removeCard,
  saveCard,
  setSlotPinned,
} from './cards';

const NOTES: CardDefinition = {
  id: 'notes',
  name: 'Notes',
  description: '',
  source: { kind: 'agent' },
  slots: [{ id: 'note', type: 'line', label: 'Note' }],
  enabled: true,
};

afterEach(() => setStore('cardDefinitions', []));

describe('persistCardDefinitions', () => {
  it('saves a user card read from the live store', () => {
    setStore('cardDefinitions', [structuredClone(NOTES)]);
    expect(persistCardDefinitions(store.cardDefinitions)[0]).toEqual(NOTES);
  });
});

describe('card order and scope', () => {
  const card = (id: string): CardDefinition => ({ ...structuredClone(NOTES), id });

  it('moves a dropped card into the row it was dropped on, either way', () => {
    setStore('cardDefinitions', [card('a'), card('b'), card('c')]);
    moveCard('a', 2);
    expect(store.cardDefinitions.map((c) => c.id)).toEqual(['b', 'c', 'a']);
    moveCard('a', 0);
    expect(store.cardDefinitions.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('lets a project override the default, under the master switch', () => {
    setStore('cardDefinitions', [{ ...card('a'), enabled: false, projects: { p1: true } }]);
    expect(enabledCards('p1').map((c) => c.id)).toEqual(['a']);
    expect(enabledCards('p2')).toEqual([]);
    setStore('showCards', false);
    try {
      expect(enabledCards('p1')).toEqual([]);
    } finally {
      setStore('showCards', true);
    }
  });
});

describe('addCard', () => {
  const card = (id: string): CardDefinition => ({ ...structuredClone(NOTES), id });

  it('adds a card at the end, but not a second card with the same id', () => {
    setStore('cardDefinitions', [card('a')]);
    expect(addCard(card('b'))).toBe(true);
    expect(addCard(card('a'))).toBe(false);
    expect(store.cardDefinitions.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('removes a card by id, keeping the order of the rest', () => {
    setStore('cardDefinitions', [card('a'), card('b'), card('c')]);
    removeCard('b');
    expect(store.cardDefinitions.map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('drops a removed card’s values, so a new card with its id starts empty', () => {
    const line = (text: string) => ({ values: { note: { type: 'line', text } }, at: 1 });
    setStore('cardDefinitions', [card('a'), card('b')]);
    setStore('tasks', { t1: { id: 't1', cards: { a: line('A'), b: line('B') } } } as never);
    removeCard('b');
    expect(store.tasks.t1.cards).toEqual({ a: line('A') });
    setStore('tasks', {});
  });

  it('refuses the reserved confidence id, and counts Confidence toward the cap', () => {
    setStore('cardDefinitions', [card('a')]);
    expect(addCard(card('confidence'))).toBe(false);
    setStore('cardDefinitions', [
      confidenceCard(true),
      ...Array.from({ length: 39 }, (_, i) => card(`c${i}`)),
    ]);
    expect(addCard(card('extra'))).toBe(false);
    expect(store.cardDefinitions).toHaveLength(40);
  });

  it('refuses a 41st card, which would be dropped on the next launch', () => {
    setStore(
      'cardDefinitions',
      Array.from({ length: 40 }, (_, i) => card(`c${i}`)),
    );
    expect(addCard(card('extra'))).toBe(false);
    expect(store.cardDefinitions).toHaveLength(40);
  });
});

describe('editing a card', () => {
  afterEach(() => setStore('tasks', {}));

  it('saves an edit in place and drops stored values of slots the new layout lost', () => {
    setStore('cardDefinitions', [
      { ...structuredClone(NOTES), id: 'a' },
      {
        ...structuredClone(NOTES),
        slots: [...NOTES.slots, { id: 'old', type: 'line', label: 'Old' }],
      },
    ]);
    setStore('tasks', {
      t1: {
        id: 't1',
        cards: {
          notes: {
            values: { note: { type: 'line', text: 'Keep' }, old: { type: 'line', text: 'Drop' } },
            at: 5,
          },
        },
      },
    } as never);
    saveCard({ ...structuredClone(NOTES), name: 'Renamed', pinned: ['note'] });
    expect(store.cardDefinitions.map((c) => [c.id, c.name])).toEqual([
      ['a', 'Notes'],
      ['notes', 'Renamed'],
    ]);
    expect(store.cardDefinitions[1].slots.map((slot) => slot.id)).toEqual(['note']);
    expect(store.tasks.t1.cards?.notes).toEqual({
      values: { note: { type: 'line', text: 'Keep' } },
      at: 5,
    });
  });
});

describe('the cards offer and pins', () => {
  afterEach(() => setStore('cardsOfferPending', false));

  it('turns the free cards on, and leaves the rest as they were', () => {
    setStore('cardDefinitions', [
      ...defaultCards(false),
      { ...structuredClone(NOTES), enabled: false },
    ]);
    setStore('cardsOfferPending', true);
    answerCardsOffer(true);
    expect(store.cardsOfferPending).toBe(false);
    expect(store.cardDefinitions.map((card) => [card.id, card.enabled])).toEqual([
      ['confidence', true],
      ['branch-health', true],
      ['diff-size', true],
      ['notes', false],
    ]);
  });

  it('closes the offer without changing a card when declined', () => {
    setStore('cardDefinitions', defaultCards(false));
    setStore('cardsOfferPending', true);
    answerCardsOffer(false);
    expect(store.cardsOfferPending).toBe(false);
    expect(store.cardDefinitions.some((card) => card.enabled)).toBe(false);
  });

  it('pins and unpins a slot, dropping the list when empty', () => {
    setStore('cardDefinitions', [structuredClone(NOTES)]);
    setSlotPinned('notes', 'note', true);
    expect(store.cardDefinitions[0].pinned).toEqual(['note']);
    setSlotPinned('notes', 'note', false);
    expect(store.cardDefinitions[0]).not.toHaveProperty('pinned');
  });
});

describe('modelCallsPerTurn', () => {
  const risks = (extra: Partial<CardDefinition>): CardDefinition => ({
    ...structuredClone(NOTES),
    id: 'risks',
    source: {
      kind: 'model',
      model: 'default',
      prompt: 'x',
      inputs: ['diff'],
      trigger: 'after-turn',
    },
    ...extra,
  });
  afterEach(() => setStore('projects', []));

  it('counts the most after-turn model cards any one project runs, overrides included', () => {
    setStore('showCards', true);
    setStore('projects', [{ id: 'p1' }, { id: 'p2' }] as never);
    setStore('cardDefinitions', [
      risks({ id: 'a', enabled: false, projects: { p1: true } }),
      risks({ id: 'b', enabled: true, projects: { p2: false } }),
    ]);
    expect(modelCallsPerTurn()).toBe(2);
    setStore('cardDefinitions', [risks({ enabled: true, projects: { p1: false, p2: false } })]);
    expect(modelCallsPerTurn()).toBe(0);
  });
});
