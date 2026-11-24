import { describe, expect, it } from 'vitest';
import { appFactCard } from './app-facts';
import {
  AI_PRESETS,
  BOTTOM_LINE_CARD_ID,
  exampleCheckOutput,
  missingFactCards,
  presetCard,
  sampleValue,
} from './card-gallery';
import { parseCardValues } from './card-publish';
import { checkCard } from './check-card';
import { SLOT_TYPES, restoreSlotValue } from './card-slots';

describe('gallery', () => {
  it('adds a preset under a free id, switched on', () => {
    const decisions = AI_PRESETS.find((preset) => preset.name === 'Decisions');
    expect(decisions).toBeDefined();
    if (!decisions) return;
    const card = presetCard(decisions, new Set(['decisions']));
    expect(card.id).toBe('decisions-2');
    expect(card.enabled).toBe(true);
    expect(card.slots[0]).toMatchObject({ type: 'items', addUp: true });
  });

  it('offers a Bottom line card the agent fills, shown at Finish', () => {
    const preset = AI_PRESETS.find((entry) => entry.name === 'Bottom line');
    expect(preset).toBeDefined();
    if (!preset) return;
    const card = presetCard(preset, new Set());
    expect(card).toMatchObject({ id: BOTTOM_LINE_CARD_ID, source: { kind: 'agent' } });
    expect(card.showAtFinish).toBe(true);
    // Six empty rows all task long would only be noise in the cards pane.
    expect(card.hideEmpty).toBe(true);
    const values = parseCardValues(card, {
      verdict: 'Needs your decision: retry limit not set.',
      needs: [{ text: 'Cap retries at 5?', severity: 'block' }],
      decided: [{ text: 'Retries back off exponentially.', severity: 'info' }],
    });
    expect(values.verdict).toEqual({
      type: 'line',
      text: 'Needs your decision: retry limit not set.',
    });
    expect(values.needs).toMatchObject({ items: [{ severity: 'block' }] });
  });

  it('offers only the app facts no card shows yet', () => {
    const offered = missingFactCards([appFactCard('commits', true), appFactCard('ci', false)]);
    expect(offered.map((card) => card.id)).toEqual([
      'plan',
      'diff-size',
      'branch-health',
      'activity',
      'remote-branch',
    ]);
  });

  it('has a valid sample value for every slot type', () => {
    for (const type of SLOT_TYPES) {
      const slot = { id: 's', type, label: 'S' };
      expect(restoreSlotValue(slot, sampleValue(slot))).toEqual(sampleValue(slot));
    }
  });
});

describe('exampleCheckOutput', () => {
  it('is JSON a check can write: keyed by slot id, every value accepted', () => {
    const slots = SLOT_TYPES.map((type) => ({ id: `my-${type}`, type, label: type }));
    const card = { ...checkCard({ id: 'lint', name: 'Lint' }), slots };
    const example: unknown = JSON.parse(exampleCheckOutput(slots));
    expect(Object.keys(example as object)).toEqual([
      'my-line',
      'my-text',
      'my-score',
      'my-scores',
      'my-stat',
      'my-items',
      'my-checklist',
      'my-status',
    ]);
    expect(Object.keys(parseCardValues(card, example))).toHaveLength(8);
  });
});
