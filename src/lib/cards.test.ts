import { describe, expect, it } from 'vitest';
import {
  defaultConfidenceSlots,
  confidenceCard,
  freeCardId,
  withProjectSetting,
  persistCardDefinitions,
  restoreCardDefinitions,
  restoreTaskCards,
  type CardDefinition,
} from './cards';

const CI_CARD: CardDefinition = {
  id: 'ci',
  name: 'CI',
  description: 'PR check results',
  source: { kind: 'app', fact: 'ci' },
  slots: [{ id: 'runs', type: 'status', label: 'Runs' }],
  enabled: true,
  projects: { p2: false },
  pinned: ['runs'],
};

/** Restored cards other than the built-in Confidence card, which restore always adds. */
function userCards(raw: unknown): CardDefinition[] {
  return restoreCardDefinitions(raw).filter((card) => !card.builtIn);
}

describe('restoreCardDefinitions', () => {
  it('adds Confidence switched off when an older save has no cards', () => {
    expect(restoreCardDefinitions(undefined)).toEqual([
      {
        id: 'confidence',
        name: 'Confidence',
        description: expect.any(String) as string,
        builtIn: 'confidence',
        source: { kind: 'agent' },
        slots: defaultConfidenceSlots(),
        enabled: false,
      },
    ]);
  });

  it('keeps the Confidence pin and drops pins of slots a card lacks', () => {
    const restored = restoreCardDefinitions([
      { ...confidenceCard(true), pinned: ['scores', 'nope'] },
      {
        id: 'diff-size',
        name: 'Diff size',
        source: { kind: 'app', fact: 'diff-size' },
        slots: [{ id: 'lines', type: 'line', label: 'Lines' }],
        enabled: true,
        pinned: ['lines', 'gone'],
      },
    ]);
    expect(restored.map((card) => card.pinned)).toEqual([['scores'], ['lines']]);
  });

  it('keeps the mini view of a user card, but not of Confidence, whose pin already is one', () => {
    const restored = restoreCardDefinitions([
      { ...confidenceCard(true), mini: true },
      { ...CI_CARD, mini: true },
      { ...CI_CARD, id: 'ci-2', mini: 'yes' },
    ]);
    expect(restored.map((card) => card.mini)).toEqual([undefined, true, undefined]);
  });

  it('keeps hiding a card until it has values only when switched on', () => {
    const restored = restoreCardDefinitions([
      { ...confidenceCard(true), hideEmpty: true },
      { ...CI_CARD, hideEmpty: true },
      { ...CI_CARD, id: 'ci-2', hideEmpty: 'yes' },
    ]);
    expect(restored.map((card) => card.hideEmpty)).toEqual([undefined, true, undefined]);
  });

  it('keeps Confidence where the user put it, with its on/off and project overrides', () => {
    const notes: CardDefinition = {
      id: 'notes',
      name: 'Notes',
      description: '',
      source: { kind: 'agent' },
      slots: [{ id: 'text', type: 'text', label: 'Text' }],
      enabled: false,
    };
    const confidence = { ...confidenceCard(true), projects: { p1: false } };
    const restored = restoreCardDefinitions(persistCardDefinitions([notes, confidence]));
    expect(restored).toEqual([notes, confidence]);
  });

  it('round-trips cards in their saved order', () => {
    const notes: CardDefinition = {
      id: 'notes',
      name: 'Notes',
      description: '',
      source: { kind: 'agent' },
      slots: [{ id: 'text', type: 'text', label: 'Text' }],
      enabled: false,
    };
    expect(userCards(persistCardDefinitions([CI_CARD, notes]))).toEqual([CI_CARD, notes]);
  });

  it('drops a saved Brief entry from before briefs were removed', () => {
    expect(userCards([{ id: 'brief', builtIn: 'brief', pinned: ['goal'] }])).toEqual([]);
  });

  it('drops malformed and duplicate cards but keeps the rest', () => {
    const restored = userCards([
      null,
      { id: 'Bad Id', source: { kind: 'agent' }, slots: [{ id: 'a', type: 'line' }] },
      { id: 'no-slots', source: { kind: 'agent' }, slots: [] },
      { id: 'unknown-source', source: { kind: 'shell' }, slots: [{ id: 'a', type: 'line' }] },
      { id: 'notes', source: { kind: 'agent' }, slots: [{ id: 'a', type: 'line' }] },
      { id: 'notes', source: { kind: 'agent' }, slots: [{ id: 'b', type: 'line' }] },
    ]);
    expect(restored.map((card) => card.id)).toEqual(['notes']);
    expect(restored[0].slots[0]).toEqual({ id: 'a', type: 'line', label: 'a' });
  });

  it('drops pins of slots the card no longer has', () => {
    const [card] = userCards([{ ...CI_CARD, pinned: ['runs', 'gone'] }]);
    expect(card.pinned).toEqual(['runs']);
  });

  it('falls back to the default model for one this app does not know', () => {
    const [card] = userCards([
      {
        id: 'release-note',
        source: { kind: 'model', model: 'gpt-9', prompt: 'One line', inputs: ['diff', 'x'] },
        slots: [{ id: 'note', type: 'text', label: 'Note' }],
      },
    ]);
    expect(card.source).toEqual({
      kind: 'model',
      model: 'default',
      prompt: 'One line',
      inputs: ['diff'],
      trigger: 'after-turn',
    });
  });
});

describe('restoreTaskCards', () => {
  it('round-trips values of every slot type', () => {
    const saved = {
      ci: {
        at: 5,
        fingerprint: 'abc',
        replyFingerprint: 'r1',
        values: {
          goal: { type: 'line', text: 'Ship it' },
          log: { type: 'text', text: 'line 1\nline 2' },
          correct: { type: 'score', score: 88, why: 'Tested' },
          added: { type: 'stat', value: 412, unit: 'lines', limit: 600 },
          risks: { type: 'items', items: [{ text: 'No dedupe', severity: 'block', file: 'q.ts' }] },
          steps: { type: 'checklist', items: [{ text: 'Write test', state: 'done' }] },
          runs: { type: 'status', rows: [{ state: 'fail', text: 'lint', value: '2 errors' }] },
        },
      },
    };
    expect(restoreTaskCards(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });

  it('drops values that no longer validate and keeps the rest', () => {
    const restored = restoreTaskCards({
      c: {
        at: 1,
        values: {
          ok: { type: 'line', text: 'fine' },
          score: { type: 'score', score: 140 },
          kind: { type: 'chart', points: [] },
          junk: { type: 'items', items: [null, 3] },
          // An empty list is a stored "nothing found", not a broken value.
          empty: { type: 'items', items: [] },
        },
      },
      'Not An Id': { at: 1, values: { a: { type: 'line', text: 'x' } } },
    });
    expect(restored).toEqual({
      c: {
        at: 1,
        values: { ok: { type: 'line', text: 'fine' }, empty: { type: 'items', items: [] } },
      },
    });
  });

  it('returns nothing for a task that never had card values', () => {
    expect(restoreTaskCards(undefined)).toBeUndefined();
    expect(restoreTaskCards({})).toBeUndefined();
  });
});

describe('freeCardId', () => {
  it('makes an id from a name, never the reserved confidence id or a taken one', () => {
    expect(freeCardId('Session numbers!', new Set())).toBe('session-numbers');
    expect(freeCardId('Confidence', new Set())).toBe('confidence-2');
    expect(freeCardId('Risks', new Set(['risks', 'risks-2']))).toBe('risks-3');
    expect(freeCardId('???', new Set())).toBe('card');
    expect(freeCardId('A very long card name that goes on and on and on', new Set())).toBe(
      'a-very-long-card-name-that-goes-on-and-o',
    );
  });
});

describe('withProjectSetting', () => {
  it('sets a project override, and drops it when it matches the default', () => {
    expect(withProjectSetting({ enabled: true }, 'p1', false)).toEqual({ p1: false });
    expect(
      withProjectSetting({ enabled: true, projects: { p1: false, p2: false } }, 'p1', true),
    ).toEqual({
      p2: false,
    });
    expect(
      withProjectSetting({ enabled: false, projects: { p1: true } }, 'p1', false),
    ).toBeUndefined();
  });
});
