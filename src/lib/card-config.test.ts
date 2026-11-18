import { describe, expect, it } from 'vitest';
import {
  addedModelInputs,
  changesModel,
  droppedSlotIds,
  parseCardConfig,
  savedAsSent,
  switchesOnAi,
} from './card-config';
import type { CardDefinition } from './cards';

const RISKS: CardDefinition = {
  id: 'risks',
  name: 'Risks',
  description: 'What could go wrong',
  source: {
    kind: 'model',
    model: 'default',
    prompt: 'List the risks.',
    inputs: ['diff'],
    trigger: 'manual',
  },
  slots: [
    { id: 'top', type: 'line', label: 'Top risk' },
    { id: 'all', type: 'items', label: 'All risks' },
  ],
  enabled: false,
};
const LINT: CardDefinition = {
  id: 'lint',
  name: 'Lint',
  description: '',
  source: { kind: 'check', checkId: 'lint', mode: 'exit-code', trigger: 'manual' },
  slots: [{ id: 'result', type: 'status', label: 'Result' }],
  enabled: true,
};

describe('parseCardConfig', () => {
  it('returns a well-formed card as it was sent', () => {
    expect(parseCardConfig(structuredClone(RISKS))).toEqual(RISKS);
  });

  it('names the id when it is missing or malformed', () => {
    expect(() => parseCardConfig({ ...RISKS, id: 'My Risks' })).toThrow('"id"');
    expect(() => parseCardConfig({ ...RISKS, id: 'x'.repeat(41) })).toThrow('"id"');
    expect(() => parseCardConfig('risks')).toThrow('"id"');
  });

  it('names the source when the app cannot run it', () => {
    expect(() => parseCardConfig({ ...RISKS, source: { kind: 'shell' } })).toThrow(
      'Card "risks" needs a "source"',
    );
    expect(() => parseCardConfig({ ...RISKS, source: { kind: 'check', checkId: '' } })).toThrow(
      '"source"',
    );
  });

  it('names the slots when none is usable', () => {
    expect(() => parseCardConfig({ ...RISKS, slots: [] })).toThrow(
      'Card "risks" needs at least one slot',
    );
    expect(() => parseCardConfig({ ...RISKS, slots: [{ id: 'top', type: 'chart' }] })).toThrow(
      'at least one slot',
    );
  });

  it('gives an app-fact card and a pass/fail check card the one layout the app fills', () => {
    const ci = { ...RISKS, id: 'ci-2', source: { kind: 'app', fact: 'ci' }, slots: [] };
    expect(parseCardConfig(ci).slots).toEqual([{ id: 'runs', type: 'status', label: 'Checks' }]);
    const lint = { ...LINT, slots: [{ id: 'note', type: 'line', label: 'Note' }] };
    expect(parseCardConfig(lint).slots).toEqual([
      { id: 'result', type: 'status', label: 'Result' },
    ]);
    const json = { ...lint, source: { ...LINT.source, mode: 'json' } };
    expect(parseCardConfig(json).slots).toEqual([{ id: 'note', type: 'line', label: 'Note' }]);
  });

  it('keeps Confidence built in, with its default layout when sent no slots', () => {
    const card = parseCardConfig({ id: 'confidence', name: 'Sureness', enabled: true, slots: [] });
    expect(card).toMatchObject({
      id: 'confidence',
      name: 'Sureness',
      builtIn: 'confidence',
      source: { kind: 'agent' },
      enabled: true,
    });
    expect(card.slots.map((slot) => slot.id)).toEqual([
      'scores',
      'findings',
      'changes',
      'keyLine',
      'asked',
    ]);
  });
});

describe('savedAsSent', () => {
  it('ignores the order of keys', () => {
    const { id, ...rest } = RISKS;
    expect(savedAsSent({ ...rest, id }, RISKS)).toBe(true);
  });

  it('notices text that was cut and a slot that was dropped', () => {
    const long = { ...RISKS, name: 'R'.repeat(60) };
    expect(savedAsSent(long, parseCardConfig(long))).toBe(false);
    const extra = {
      ...RISKS,
      slots: [...RISKS.slots, { id: 'graph', type: 'chart', label: 'Graph' }],
    };
    expect(savedAsSent(extra, parseCardConfig(extra))).toBe(false);
  });
});

describe('switchesOnAi', () => {
  const on = { ...RISKS, enabled: true };

  it('is true for a new AI card that is on, and false for one that is off', () => {
    expect(switchesOnAi(on, undefined, ['p1'])).toBe(true);
    expect(switchesOnAi(RISKS, undefined, ['p1'])).toBe(false);
  });

  it('is false while an AI card that was on stays on, whatever else changes', () => {
    const edited: CardDefinition = {
      ...on,
      source: { ...on.source, kind: 'model', prompt: 'Other.' } as CardDefinition['source'],
    };
    expect(switchesOnAi(edited, on, ['p1'])).toBe(false);
  });

  it('is true when an AI card goes on in one project only', () => {
    expect(switchesOnAi({ ...RISKS, projects: { p1: true } }, RISKS, ['p1', 'p2'])).toBe(true);
  });

  it('is true when dropping a project override lets the card run there', () => {
    const offInP1 = { ...on, projects: { p1: false } };
    expect(switchesOnAi(on, offInP1, ['p1'])).toBe(true);
  });

  it('is true when a card that is on becomes an AI card', () => {
    expect(switchesOnAi({ ...on, id: 'lint' }, LINT, [])).toBe(true);
  });

  it('is true when an agent card that is on starts calling a model, not the other way round', () => {
    const byAgent: CardDefinition = { ...on, source: { kind: 'agent' } };
    expect(switchesOnAi(on, byAgent, ['p1'])).toBe(true);
    expect(switchesOnAi(byAgent, on, ['p1'])).toBe(false);
  });

  it('is false for a card that is not an AI card', () => {
    expect(switchesOnAi(LINT, undefined, ['p1'])).toBe(false);
  });
});

describe('changesModel and addedModelInputs', () => {
  const on: CardDefinition = { ...RISKS, enabled: true };
  const withSource = (card: CardDefinition, source: object): CardDefinition => ({
    ...card,
    source: { ...card.source, ...source } as CardDefinition['source'],
  });

  it('notice another model on a card that calls one, by default or in a project', () => {
    expect(changesModel(withSource(on, { model: 'terra' }), on, [])).toBe(true);
    const inP1 = { ...RISKS, projects: { p1: true } };
    expect(changesModel(withSource(inP1, { model: 'terra' }), inP1, ['p1'])).toBe(true);
    expect(changesModel(withSource(on, { prompt: 'Other.', trigger: 'after-turn' }), on, [])).toBe(
      false,
    );
  });

  it('list what the model is newly sent, a check run first included', () => {
    const more = withSource(on, { inputs: ['prompts', 'diff'], checkId: 'lint' });
    expect(addedModelInputs(more, on, [])).toEqual(['prompts', 'check']);
    expect(addedModelInputs(withSource(on, { inputs: [] }), on, [])).toEqual([]);
    expect(addedModelInputs(withSource(more, { checkId: 'tests' }), more, [])).toEqual(['check']);
  });

  it('leave a card alone that is only now switched on, which asks by itself', () => {
    const wider = withSource(on, { model: 'terra', inputs: ['prompts', 'diff'] });
    expect(changesModel(wider, RISKS, ['p1'])).toBe(false);
    expect(addedModelInputs(wider, RISKS, ['p1'])).toEqual([]);
  });

  it('leave a card alone that calls no model anywhere', () => {
    const wider = withSource(RISKS, { model: 'terra', inputs: ['prompts', 'diff'] });
    expect(changesModel(wider, RISKS, ['p1'])).toBe(false);
    expect(addedModelInputs(wider, RISKS, ['p1'])).toEqual([]);
    expect(changesModel(on, { ...on, source: { kind: 'agent' } }, [])).toBe(false);
  });
});

describe('droppedSlotIds', () => {
  it('lists the slots the new layout no longer has', () => {
    expect(droppedSlotIds({ ...RISKS, slots: [RISKS.slots[0]] }, RISKS)).toEqual(['all']);
    expect(droppedSlotIds(RISKS, RISKS)).toEqual([]);
    expect(droppedSlotIds(RISKS, undefined)).toEqual([]);
  });
});
