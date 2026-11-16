import { describe, expect, it } from 'vitest';
import {
  mergeRunValues,
  parseSlotValue,
  restoreSlotValue,
  type CardItem,
  type SlotDefinition,
} from './card-slots';

const FINDINGS: SlotDefinition = { id: 'findings', type: 'items', label: 'Findings', addUp: true };
const NOW: SlotDefinition = { id: 'now', type: 'line', label: 'Now' };
const items = (list: CardItem[]) => ({ type: 'items' as const, items: list });

describe('mergeRunValues', () => {
  it('prepends new add-up items tagged with the turn, skipping ones it already has', () => {
    const merged = mergeRunValues(
      [FINDINGS],
      { findings: items([{ text: 'Missing null check', severity: 'warn', turn: 1 }]) },
      {
        findings: items([
          { text: ' missing NULL check ', severity: 'block' },
          { text: 'No test for retry', severity: 'info' },
          { text: 'no test for retry', severity: 'warn' },
        ]),
      },
      3,
    );
    expect(merged.findings).toEqual(
      items([
        { text: 'No test for retry', severity: 'info', turn: 3 },
        { text: 'Missing null check', severity: 'warn', turn: 1 },
      ]),
    );
  });

  it('keeps the newest 20 add-up items', () => {
    const old = Array.from({ length: 19 }, (_, i) => ({
      text: `old ${i + 1}`,
      severity: 'info' as const,
      turn: 1,
    }));
    const fresh = ['new 1', 'new 2', 'new 3'].map((text) => ({ text, severity: 'info' as const }));
    const merged = mergeRunValues(
      [FINDINGS],
      { findings: items(old) },
      { findings: items(fresh) },
      2,
    );
    const texts = merged.findings?.type === 'items' ? merged.findings.items.map((i) => i.text) : [];
    expect(texts).toHaveLength(20);
    expect(texts.slice(0, 4)).toEqual(['new 1', 'new 2', 'new 3', 'old 1']);
    expect(texts.at(-1)).toBe('old 17');
  });

  it('replaces every other slot, drops one the run left out, and keeps add-up items a run had none for', () => {
    const merged = mergeRunValues(
      [FINDINGS, NOW],
      {
        findings: items([{ text: 'Kept', severity: 'info', turn: 1 }]),
        now: { type: 'line', text: 'Old step' },
      },
      {},
      2,
    );
    expect(merged).toEqual({ findings: items([{ text: 'Kept', severity: 'info', turn: 1 }]) });
  });

  it('keeps an add-up list that found nothing yet as empty, not missing', () => {
    expect(mergeRunValues([FINDINGS], undefined, { findings: items([]) }, 1)).toEqual({
      findings: items([]),
    });
  });
});

describe('parseSlotValue', () => {
  it('keeps a turn tag only on items that add up across turns', () => {
    const raw = { items: [{ text: 'Risky', turn: 3 }] };
    const slot: SlotDefinition = { id: 'risks', type: 'items', label: 'Risks' };
    expect(parseSlotValue(slot, raw)).toEqual({
      type: 'items',
      items: [{ text: 'Risky', severity: 'info' }],
    });
    expect(parseSlotValue({ ...slot, addUp: true }, raw)).toEqual({
      type: 'items',
      items: [{ text: 'Risky', severity: 'info', turn: 3 }],
    });
  });
});

describe('empty lists', () => {
  it('reads [] as an empty list for every list slot, and restores it', () => {
    expect(parseSlotValue({ id: 'c', type: 'checklist', label: 'C' }, [])).toEqual({
      type: 'checklist',
      items: [],
    });
    expect(parseSlotValue({ id: 's', type: 'status', label: 'S' }, { rows: [] })).toEqual({
      type: 'status',
      rows: [],
    });
    expect(restoreSlotValue(FINDINGS, { type: 'items', items: [] })).toEqual(items([]));
  });
});
