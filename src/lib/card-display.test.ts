import { describe, expect, it } from 'vitest';
import {
  areCardValuesOutdated,
  cardNeedsAttention,
  cardSummary,
  pinGroups,
  readCard,
  showsInPinRow,
  shownCards,
  showsSlotLabel,
  slotSummary,
  slotWarns,
  valueFor,
} from './card-display';
import { confidenceCard, type CardDefinition, type CardValues } from './cards';
import { legacyRatingValues } from './confidence-card';
import type { TaskConfidence } from './task-confidence';

/** A task whose Confidence card holds this rating. */
const rated = (rating: TaskConfidence) => ({ cards: { confidence: legacyRatingValues(rating) } });

const CARD: CardDefinition = {
  id: 'health',
  name: 'Health',
  description: '',
  source: { kind: 'agent' },
  slots: [
    { id: 'goal', type: 'line', label: 'Goal' },
    { id: 'done', type: 'checklist', label: 'Done' },
    { id: 'quality', type: 'score', label: 'Quality', warnBelow: 70 },
  ],
  enabled: true,
};

function values(score: number): CardValues {
  return {
    at: 1_000,
    fingerprint: 'fp',
    values: {
      goal: { type: 'line', text: 'Ship the fix' },
      done: {
        type: 'checklist',
        items: [
          { text: 'Tests', state: 'done' },
          { text: 'Docs', state: 'todo' },
        ],
      },
      quality: { type: 'score', score, why: 'x' },
    },
  };
}

describe('slotWarns', () => {
  it('warns only past the threshold the slot sets', () => {
    const slot = CARD.slots[2];
    expect(slotWarns(slot, { type: 'score', score: 69, why: '' })).toBe(true);
    expect(slotWarns(slot, { type: 'score', score: 70, why: '' })).toBe(false);
    expect(slotWarns({ ...slot, warnBelow: undefined }, { type: 'score', score: 1, why: '' })).toBe(
      false,
    );
  });
});

describe('cardSummary', () => {
  it('reads the first two values of a quiet card', () => {
    expect(cardSummary(CARD, values(90))).toBe('Ship the fix · 1/2 · next: Docs');
  });

  it('leads with what needs attention', () => {
    expect(cardSummary(CARD, values(40))).toBe('Quality 40');
  });

  it('is empty before anything filled the card', () => {
    expect(cardSummary(CARD, undefined)).toBe('');
  });
});

describe('valueFor', () => {
  it('ignores a value stored for a slot whose type has since changed', () => {
    const changed = { ...CARD.slots[0], type: 'text' as const };
    expect(valueFor(changed, values(90))).toBeUndefined();
    expect(valueFor(CARD.slots[0], values(90))).toEqual({ type: 'line', text: 'Ship the fix' });
  });

  it('shows items added up before add-up was switched off as a plain list of ten', () => {
    const slot = { id: 'risks', type: 'items' as const, label: 'Risks' };
    const items = Array.from({ length: 20 }, (_, i) => ({
      text: `risk ${i}`,
      severity: 'info' as const,
      turn: 3,
    }));
    const stored: CardValues = { at: 1, values: { risks: { type: 'items', items } } };
    const shown = valueFor(slot, stored);
    expect(shown).toEqual({
      type: 'items',
      items: Array.from({ length: 10 }, (_, i) => ({ text: `risk ${i}`, severity: 'info' })),
    });
  });
});

describe('outdated values', () => {
  it('are outdated once newer code differs from what they were made from', () => {
    const made = values(40);
    expect(areCardValuesOutdated(made, { fingerprint: 'other', at: 2_000 })).toBe(true);
    expect(areCardValuesOutdated(made, { fingerprint: 'fp', at: 2_000 })).toBe(false);
    expect(areCardValuesOutdated(made, { fingerprint: 'other', at: 500 })).toBe(false);
    expect(areCardValuesOutdated(made, undefined)).toBe(false);
  });

  it('no longer ask for attention', () => {
    expect(cardNeedsAttention(CARD, values(40), false)).toBe(true);
    expect(cardNeedsAttention(CARD, values(40), true)).toBe(false);
    expect(cardNeedsAttention(CARD, values(90), false)).toBe(false);
  });
});

describe('the Confidence card', () => {
  const card = confidenceCard(true);
  const rating = (score: number) => ({
    scores: [
      { label: 'Correct', score: 90, why: 'Tested.' },
      { label: 'Complete', score, why: 'Docs.' },
    ],
    findings: [],
    publishedAt: 1_000,
    fingerprint: 'fp',
  });

  it('waits for a rating until one is published', () => {
    const reading = readCard(card, {}, 'sonnet');
    expect(reading.at).toBeUndefined();
    expect(reading.pending).toBe('waiting for a rating');
  });

  it('summarises correctness first, then the lowest score', () => {
    const confidence: TaskConfidence = {
      scores: [
        { label: 'Minimal', score: 90, why: '' },
        { label: 'Complete', score: 70, why: '' },
        { label: 'Correctness', score: 85, why: '' },
      ],
      findings: [],
      publishedAt: 1_000,
    };
    expect(readCard(card, rated(confidence), 'sonnet').summary).toBe(
      'Correctness 85 · Complete 70 · Minimal 90',
    );
  });

  it('summarises the scores and asks for attention below 60 while current', () => {
    const low = readCard(card, rated(rating(45)), 'sonnet');
    expect(low).toMatchObject({
      at: 1_000,
      summary: 'Correct 90 · Complete 45',
      urgent: true,
      source: 'agent',
    });
    expect(readCard(card, rated(rating(60)), 'sonnet').urgent).toBe(false);
  });

  it('stops asking for attention once newer code outdates the rating', () => {
    const codeFingerprint = { fingerprint: 'newer', at: 2_000 };
    expect(readCard(card, { ...rated(rating(45)), codeFingerprint }, 'sonnet')).toMatchObject({
      outdated: true,
      urgent: false,
    });
  });

  it('credits the Finish review when the app reviewer wrote the rating', () => {
    const confidence = { ...rating(80), origin: 'review' as const };
    expect(readCard(card, rated(confidence), 'sonnet').source).toBe('review');
  });
});

describe('pinGroups', () => {
  const pinned: CardDefinition = { ...CARD, pinned: ['quality', 'goal'] };
  const confidence: CardDefinition = { ...confidenceCard(true), pinned: ['scores'] };
  const unpinned: CardDefinition = { ...CARD, id: 'other' };

  it('shows "–" before a value, and the same pins once filled; Confidence not until rated', () => {
    const empty = pinGroups([confidence, pinned, unpinned], {});
    expect(empty.map((group) => group.pins.map((pin) => [pin.label, pin.text]))).toEqual([
      [
        ['', '–'],
        ['Quality', '–'],
      ],
    ]);
    const filled = pinGroups([pinned], { cards: { health: values(90) } });
    expect(filled[0].pins.map((pin) => [pin.label, pin.text, pin.warn])).toEqual([
      ['', 'Ship the fix', false],
      ['Quality', '90', false],
    ]);
  });

  it('leaves out pinned Confidence until the task has a rating', () => {
    expect(pinGroups([confidence], {})).toEqual([]);
    const rating: TaskConfidence = {
      publishedAt: 1,
      scores: [{ label: 'Correct', score: 80, why: '' }],
      findings: [],
    };
    expect(pinGroups([confidence], rated(rating))[0].pins.map((pin) => pin.text)).toEqual(['80']);
  });

  it('shows a mini card as its name and summary, before any pinned slot', () => {
    const mini: CardDefinition = { ...CARD, mini: true, pinned: ['quality'] };
    expect(showsInPinRow({ ...CARD, mini: true })).toBe(true);
    expect(showsInPinRow(CARD)).toBe(false);
    const empty = pinGroups([{ ...CARD, mini: true }], {});
    expect(empty[0].pins.map((pin) => [pin.label, pin.text])).toEqual([['Health', '–']]);
    const [group] = pinGroups([mini], { cards: { health: values(40) } });
    expect(group.pins.map((pin) => [pin.label, pin.text, pin.warn])).toEqual([
      ['Health', 'Quality 40', true],
      ['Quality', '40', true],
    ]);
  });

  it('warns only past the threshold, and not once outdated', () => {
    const low = pinGroups([pinned], { cards: { health: values(50) } });
    expect(low[0].pins[1]).toMatchObject({ warn: true, faded: false });
    const code = { fingerprint: 'newer', at: 2_000 };
    const old = pinGroups([pinned], { cards: { health: values(50) }, codeFingerprint: code });
    expect(old[0].pins[1]).toMatchObject({ warn: false, faded: true });
  });

  it('pins each Confidence score, correctness then the lowest first, warning below 60', () => {
    const rating: TaskConfidence = {
      publishedAt: 1,
      scores: [
        { label: 'Minimal', score: 88, why: '' },
        { label: 'Complete', score: 55, why: '' },
        { label: 'Correct', score: 80, why: '' },
      ],
      findings: [],
    };
    const [group] = pinGroups([confidence], rated(rating));
    expect(group.pins.map((pin) => [pin.label, pin.text, pin.warn])).toEqual([
      ['Correct', '80', false],
      ['Complete', '55', true],
      ['Minimal', '88', false],
    ]);
  });
});

describe('slotSummary of an empty list', () => {
  it('says None for items, checklist and status', () => {
    expect(slotSummary({ id: 'i', type: 'items', label: 'I' }, { type: 'items', items: [] })).toBe(
      'None',
    );
    expect(
      slotSummary({ id: 'c', type: 'checklist', label: 'C' }, { type: 'checklist', items: [] }),
    ).toBe('None');
    expect(slotSummary({ id: 's', type: 'status', label: 'S' }, { type: 'status', rows: [] })).toBe(
      'None',
    );
  });
});

describe('showsSlotLabel', () => {
  const only = (slot: CardDefinition['slots'][number]) =>
    showsSlotLabel({ ...CARD, slots: [slot] }, slot);

  it('labels every slot of a card with several', () => {
    expect(CARD.slots.map((slot) => showsSlotLabel(CARD, slot))).toEqual([true, true, true]);
  });

  it("drops the label of a card's only list or text block, which repeats the card's name", () => {
    expect(only({ id: 'd', type: 'items', label: 'Decisions' })).toBe(false);
    expect(only({ id: 's', type: 'checklist', label: 'Steps' })).toBe(false);
    expect(only({ id: 'r', type: 'status', label: 'Result' })).toBe(false);
    expect(only({ id: 'n', type: 'text', label: 'Note' })).toBe(false);
  });

  it('keeps the label of a lone line or number, which says what the short value is', () => {
    expect(only({ id: 'v', type: 'line', label: 'Verdict' })).toBe(true);
    expect(only({ id: 'q', type: 'score', label: 'Quality' })).toBe(true);
    expect(only({ id: 'f', type: 'stat', label: 'Files' })).toBe(true);
  });
});

describe('shownCards', () => {
  const hidden: CardDefinition = { ...CARD, id: 'hidden', hideEmpty: true };
  const manual: CardDefinition = {
    ...CARD,
    id: 'manual',
    hideEmpty: true,
    source: { kind: 'check', checkId: 'lint', mode: 'json', trigger: 'manual' },
  };

  it('leaves out a card set to hide until it has values, until it has some', () => {
    expect(shownCards([CARD, hidden], {})).toEqual([CARD]);
    expect(shownCards([CARD, hidden], { cards: { hidden: values(90) } })).toEqual([CARD, hidden]);
  });

  it('keeps a card without values while its run is going or failed', () => {
    expect(shownCards([hidden], {}, (card) => card.id === 'hidden')).toEqual([hidden]);
  });

  it('keeps a card that fills only when run, since hiding it would leave no way to run it', () => {
    expect(shownCards([manual], {})).toEqual([manual]);
  });

  it('leaves out Confidence until the task has a rating', () => {
    const confidence = confidenceCard(true);
    expect(shownCards([confidence, CARD], {})).toEqual([CARD]);
    const rating: TaskConfidence = {
      publishedAt: 1_000,
      scores: [{ label: 'Correct', score: 90, why: '' }],
      findings: [],
    };
    expect(shownCards([confidence, CARD], rated(rating))).toEqual([confidence, CARD]);
  });
});
