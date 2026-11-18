import { describe, expect, it } from 'vitest';
import { describeAgentCard, parseCardValues } from './card-publish';
import type { CardDefinition } from './cards';

const CARD: CardDefinition = {
  id: 'done-criteria',
  name: 'Done criteria',
  description: 'What has to be true before this ships',
  source: { kind: 'agent' },
  slots: [
    { id: 'steps', type: 'checklist', label: 'Steps' },
    { id: 'note', type: 'line', label: 'Note', hint: 'One sentence' },
  ],
  enabled: true,
};

describe('parseCardValues', () => {
  it('keeps the values that fit their slots', () => {
    expect(
      parseCardValues(CARD, { steps: [{ text: 'Tests', state: 'done' }], note: 'Nearly there' }),
    ).toEqual({
      steps: { type: 'checklist', items: [{ text: 'Tests', state: 'done' }] },
      note: { type: 'line', text: 'Nearly there' },
    });
  });

  it('accepts an empty checklist as "nothing to list"', () => {
    expect(parseCardValues(CARD, { steps: [] })).toEqual({
      steps: { type: 'checklist', items: [] },
    });
  });

  it('accepts a line within its limit even when quoting doubles its JSON', () => {
    // 150 quotes fit a 200-character line but escape to over 300 JSON characters.
    const note = '"'.repeat(150);
    expect(parseCardValues(CARD, { note })).toEqual({ note: { type: 'line', text: note } });
  });

  it('names the slot an oversized value was sent for', () => {
    const steps = Array.from({ length: 12 }, () => ({ text: 'x'.repeat(5_000), state: 'todo' }));
    expect(() => parseCardValues(CARD, { steps, note: 'ok' })).toThrow(/Slot "steps" is too large/);
  });

  it('names a slot the card does not have', () => {
    expect(() => parseCardValues(CARD, { summary: 'x' })).toThrow(
      'Card "done-criteria" has no slot "summary"; its slots are "steps", "note".',
    );
  });

  it('says what shape a malformed value needs', () => {
    expect(() => parseCardValues(CARD, { note: 42 })).toThrow(
      /Slot "note" \(line\) needs one line/,
    );
  });

  it('rejects an empty payload', () => {
    expect(() => parseCardValues(CARD, {})).toThrow('Send a value for at least one slot.');
    expect(() => parseCardValues(CARD, ['note'])).toThrow(/must be an object/);
  });
});

describe('describeAgentCard', () => {
  it('lists each slot with the value it takes', () => {
    expect(describeAgentCard(CARD)).toEqual({
      card: 'done-criteria',
      name: 'Done criteria',
      description: 'What has to be true before this ships',
      slots: [
        {
          id: 'steps',
          type: 'checklist',
          label: 'Steps',
          value: 'at most 12 of {text, state: "done" | "current" | "todo"}',
        },
        {
          id: 'note',
          type: 'line',
          label: 'Note',
          hint: 'One sentence',
          value: 'one line, at most 240 characters',
        },
      ],
    });
  });
});
