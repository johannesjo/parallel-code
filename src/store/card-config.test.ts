import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./check-suite-state', () => ({
  getProjectChecks: () => [{ id: 'lint', name: 'Lint', command: 'npm run lint' }],
}));

import type { SlotValue } from '../lib/card-slots';
import { confidenceCard, type CardDefinition } from '../lib/cards';
import {
  answerCardChange,
  changeCardConfig,
  readCardConfig,
  waitingCardChanges,
} from './card-config';
import { store, setStore } from './core';
import type { Project, Task } from './types';

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
const TOP_VALUE: SlotValue = { type: 'line', text: 'Token expiry' };

const ids = () => store.cardDefinitions.map((card) => card.id);
const card = (id: string) => store.cardDefinitions.find((entry) => entry.id === id);
const save = (definition: unknown, position?: number) =>
  changeCardConfig('t1', { action: 'save', card: definition, position });
const remove = (id: string) => changeCardConfig('t1', { action: 'remove', card: id });

beforeEach(() => {
  for (const waiting of waitingCardChanges()) answerCardChange(waiting.cardId, false);
  // Reading hands each task its answers once, so nothing carries over from the test before.
  for (const taskId of Object.keys(store.tasks)) readCardConfig(taskId);
  setStore('showCards', true);
  setStore('briefModel', 'sonnet');
  setStore('projects', [{ id: 'p1', name: 'App', path: '/repo' } as unknown as Project]);
  setStore('cardDefinitions', [confidenceCard(false), structuredClone(RISKS)]);
  setStore('tasks', {
    t1: { id: 't1', name: 'Fix login', projectId: 'p1' } as unknown as Task,
    t2: { id: 't2', name: 'Other', projectId: 'p1' } as unknown as Task,
  });
});

describe('readCardConfig', () => {
  it('returns every card as saved, with what an agent needs to write one', () => {
    expect(readCardConfig('t1')).toEqual({
      showCards: true,
      defaultModel: 'sonnet',
      project: { id: 'p1', name: 'App' },
      checks: [{ id: 'lint', name: 'Lint' }],
      cards: [confidenceCard(false), RISKS],
      waiting: [],
      answers: [],
    });
  });

  it('refuses a task the app does not have', () => {
    expect(() => readCardConfig('gone')).toThrow('Task not available');
  });
});

describe('changeCardConfig: changes made at once', () => {
  it('adds a card at the end, or at the position asked for', () => {
    expect(save(LINT)).toEqual({ status: 'saved', card: LINT });
    expect(ids()).toEqual(['confidence', 'risks', 'lint']);
    save({ ...LINT, id: 'lint-2' }, 0);
    expect(ids()).toEqual(['lint-2', 'confidence', 'risks', 'lint']);
  });

  it('replaces a card in place and moves it when a position is given', () => {
    save(LINT);
    const renamed = { ...RISKS, name: 'Dangers' };
    expect(save(renamed)).toEqual({ status: 'saved', card: renamed });
    expect(ids()).toEqual(['confidence', 'risks', 'lint']);
    expect(card('risks')?.name).toBe('Dangers');
    save(renamed, 2);
    expect(ids()).toEqual(['confidence', 'lint', 'risks']);
  });

  it('says so when the card was not saved exactly as sent', () => {
    const result = save({ ...LINT, name: 'L'.repeat(60) });
    expect(result).toMatchObject({ status: 'saved', card: { name: 'L'.repeat(40) } });
    expect(result).toHaveProperty('note', expect.stringContaining('not exactly as sent'));
  });

  it('rejects a malformed card and leaves the cards as they were', () => {
    expect(() => save({ ...RISKS, id: 'empty', slots: [] })).toThrow('at least one slot');
    expect(() => changeCardConfig('t1', { action: 'rename' })).toThrow('card_config');
    expect(ids()).toEqual(['confidence', 'risks']);
  });

  it('refuses a new card once the cap is reached', () => {
    const many = Array.from({ length: 39 }, (_, n) => ({ ...LINT, id: `c${n}` }));
    setStore('cardDefinitions', [confidenceCard(false), ...many]);
    expect(() => save(LINT)).toThrow('40 cards');
    expect(save({ ...LINT, id: 'c0', name: 'Renamed' })).toMatchObject({ status: 'saved' });
  });

  it('switches an AI card off, and edits one that stays on, without asking', () => {
    setStore('cardDefinitions', 1, 'enabled', true);
    const edited = { ...RISKS, enabled: true, description: 'Sharper' };
    expect(save(edited)).toMatchObject({ status: 'saved' });
    expect(save(RISKS)).toMatchObject({ status: 'saved' });
    expect(card('risks')?.enabled).toBe(false);
    expect(waitingCardChanges()).toEqual([]);
  });

  it('edits the prompt and trigger of an AI card that is on, and sends less, without asking', () => {
    setStore('cardDefinitions', 1, 'enabled', true);
    const source = { ...RISKS.source, prompt: 'Sharper.', trigger: 'after-turn', inputs: [] };
    expect(save({ ...RISKS, enabled: true, source })).toMatchObject({ status: 'saved' });
  });

  it('changes the model and the inputs of an AI card that is off without asking', () => {
    const source = { ...RISKS.source, model: 'terra', inputs: ['prompts', 'diff'] };
    expect(save({ ...RISKS, source })).toMatchObject({ status: 'saved' });
  });

  it('removes a card that holds no values', () => {
    expect(remove('risks')).toEqual({ status: 'removed', card: 'risks' });
    expect(ids()).toEqual(['confidence']);
  });

  it('refuses to remove Confidence or a card that does not exist', () => {
    expect(() => remove('confidence')).toThrow('built in');
    expect(() => remove('nope')).toThrow('There is no card "nope"');
  });

  it('keeps the Confidence layout when only its switch is sent', () => {
    save({ ...card('confidence'), slots: [{ id: 'scores', type: 'scores', label: 'Mine' }] });
    save({ id: 'confidence', enabled: true });
    expect(card('confidence')?.slots).toEqual([
      { id: 'scores', type: 'scores', label: 'Mine', warnBelow: 60 },
    ]);
  });

  it('changes the name, switches and pins of Confidence but keeps its source', () => {
    expect(
      save({
        id: 'confidence',
        name: 'Sureness',
        enabled: false,
        pinned: ['scores'],
        source: { kind: 'model', model: 'default', prompt: 'x', inputs: [], trigger: 'manual' },
      }),
    ).toMatchObject({
      status: 'saved',
      card: { name: 'Sureness', pinned: ['scores'], source: { kind: 'agent' } },
    });
    expect(card('confidence')).toMatchObject({ builtIn: 'confidence', pinned: ['scores'] });
  });
});

describe('changeCardConfig: changes that wait for a click', () => {
  it('holds back switching on an AI card until the user applies it', () => {
    const result = save({ ...RISKS, enabled: true });
    expect(result).toMatchObject({ status: 'waiting', card: 'risks' });
    expect(result).toHaveProperty('message', expect.stringContaining('switches on an AI card'));
    expect(card('risks')?.enabled).toBe(false);
    expect(waitingCardChanges()).toMatchObject([{ cardId: 'risks', asker: 'Fix login' }]);
    expect(readCardConfig('t1').waiting).toEqual([
      { card: 'risks', change: expect.stringContaining('switches on an AI card') },
    ]);

    answerCardChange('risks', true);
    expect(card('risks')?.enabled).toBe(true);
    expect(waitingCardChanges()).toEqual([]);
  });

  it('says what a model card will send when it is switched on, once', () => {
    const source = { ...RISKS.source, inputs: ['prompts', 'diff'], checkId: 'lint' };
    save({ ...RISKS, enabled: true, source });
    expect(waitingCardChanges()[0].change).toBe(
      'change "Risks", which switches on an AI card (Sonnet, on demand, sends your prompts, the diff, a check\'s output)',
    );
    save({ ...RISKS, enabled: true, source: { kind: 'agent' } });
    expect(waitingCardChanges()[0].change).toBe(
      'change "Risks", which switches on an AI card (agent, when published)',
    );
  });

  it('holds back another model for an AI card that is on', () => {
    setStore('cardDefinitions', 1, 'enabled', true);
    const source = { ...RISKS.source, model: 'terra' };
    expect(save({ ...RISKS, enabled: true, source })).toMatchObject({ status: 'waiting' });
    expect(waitingCardChanges()[0].change).toBe(
      'change "Risks", which changes the model of an AI card that is on (to GPT-6.1-Terra)',
    );
    expect(card('risks')?.source).toMatchObject({ model: 'default' });
    answerCardChange('risks', true);
    expect(card('risks')?.source).toMatchObject({ model: 'terra' });
  });

  it('holds back sending more to the model of an AI card that is on', () => {
    setStore('cardDefinitions', 1, 'enabled', true);
    const source = { ...RISKS.source, inputs: ['prompts', 'diff'], checkId: 'lint' };
    expect(save({ ...RISKS, enabled: true, source })).toMatchObject({ status: 'waiting' });
    expect(waitingCardChanges()[0].change).toBe(
      'change "Risks", which sends more to the model of an AI card that is on (your prompts, a check\'s output)',
    );
    expect(card('risks')?.source).toMatchObject({ inputs: ['diff'] });
  });

  it('adds nothing for a new AI card that is on until the user applies it', () => {
    const notes: CardDefinition = {
      ...LINT,
      id: 'notes',
      source: { kind: 'agent' },
      enabled: true,
    };
    expect(save(notes, 0)).toMatchObject({ status: 'waiting' });
    expect(ids()).toEqual(['confidence', 'risks']);
    answerCardChange('notes', true);
    expect(ids()).toEqual(['notes', 'confidence', 'risks']);
  });

  it('drops a change the user dismisses', () => {
    save({ ...RISKS, enabled: true });
    answerCardChange('risks', false);
    expect(card('risks')?.enabled).toBe(false);
    expect(waitingCardChanges()).toEqual([]);
  });

  it('holds back a layout that deletes values tasks hold, and says on how many', () => {
    setStore('tasks', 't2', 'cards', {
      risks: { values: { all: { type: 'items', items: [] } }, at: 1 },
    });
    setStore('tasks', 't1', 'cards', { risks: { values: { top: TOP_VALUE }, at: 1 } });
    const narrower = { ...RISKS, slots: [RISKS.slots[0]] };
    const result = save(narrower);
    expect(result).toMatchObject({ status: 'waiting' });
    expect(result).toHaveProperty('message', expect.stringContaining('1 task'));
    expect(card('risks')?.slots).toHaveLength(2);

    answerCardChange('risks', true);
    expect(card('risks')?.slots).toHaveLength(1);
    expect(store.tasks.t2.cards?.risks.values).toEqual({});
    expect(store.tasks.t1.cards?.risks.values).toEqual({ top: TOP_VALUE });
  });

  it('drops slots at once when no task holds a value for them', () => {
    setStore('tasks', 't1', 'cards', { risks: { values: { top: TOP_VALUE }, at: 1 } });
    expect(save({ ...RISKS, slots: [RISKS.slots[0]] })).toMatchObject({ status: 'saved' });
  });

  it('holds back removing a card whose values tasks hold', () => {
    setStore('tasks', 't1', 'cards', { risks: { values: { top: TOP_VALUE }, at: 1 } });
    expect(remove('risks')).toMatchObject({
      status: 'waiting',
      message: expect.stringContaining('1 task'),
    });
    expect(ids()).toEqual(['confidence', 'risks']);
    answerCardChange('risks', true);
    expect(ids()).toEqual(['confidence']);
    expect(store.tasks.t1.cards?.risks).toBeUndefined();
  });

  it('keeps one waiting change per card, the newest', () => {
    save({ ...RISKS, enabled: true });
    save({ ...RISKS, enabled: true, name: 'Dangers' });
    expect(waitingCardChanges()).toHaveLength(1);
    answerCardChange('risks', true);
    expect(card('risks')?.name).toBe('Dangers');
  });

  it('lets a later change made at once take the place of the one waiting', () => {
    save({ ...RISKS, enabled: true });
    expect(save({ ...RISKS, name: 'Dangers' })).toMatchObject({ status: 'saved' });
    expect(waitingCardChanges()).toEqual([]);
    save({ ...RISKS, enabled: true });
    expect(remove('risks')).toMatchObject({ status: 'removed' });
    expect(waitingCardChanges()).toEqual([]);
  });

  it('tells the asking agent, once, that the user applied its change', () => {
    save({ ...RISKS, enabled: true });
    answerCardChange('risks', true);
    expect(readCardConfig('t1').answers).toEqual([
      {
        card: 'risks',
        change: expect.stringContaining('switches on an AI card'),
        answer: 'applied',
      },
    ]);
    expect(readCardConfig('t1').answers).toEqual([]);
  });

  it('tells the asking agent, and only it, that the user dismissed its change', () => {
    save({ ...RISKS, enabled: true });
    answerCardChange('risks', false);
    expect(readCardConfig('t2').answers).toEqual([]);
    expect(readCardConfig('t1').answers).toMatchObject([{ card: 'risks', answer: 'dismissed' }]);
  });

  it('tells the asking agent when the change could no longer be applied, and why', () => {
    save({ ...RISKS, enabled: true });
    setStore('cardDefinitions', 1, 'name', 'Renamed by the user');
    answerCardChange('risks', true);
    expect(readCardConfig('t1').answers).toEqual([
      {
        card: 'risks',
        change: expect.any(String),
        answer: 'not applied',
        reason: expect.stringContaining('The cards changed since the agent asked'),
      },
    ]);
  });

  it('tells the asking agent when another task asked something else for the card', () => {
    save({ ...RISKS, enabled: true });
    changeCardConfig('t2', { action: 'save', card: { ...RISKS, enabled: true, name: 'X' } });
    expect(readCardConfig('t1').answers).toMatchObject([{ card: 'risks', answer: 'replaced' }]);
    expect(readCardConfig('t2').answers).toEqual([]);
  });

  it('says a waiting change is lost if the app restarts', () => {
    expect(save({ ...RISKS, enabled: true })).toHaveProperty(
      'message',
      expect.stringContaining('card_config_read'),
    );
  });

  it('tells the user when a change can no longer be applied', () => {
    save({ ...RISKS, id: 'late', enabled: true });
    const many = Array.from({ length: 39 }, (_, n) => ({ ...LINT, id: `c${n}` }));
    setStore('cardDefinitions', [confidenceCard(false), ...many]);
    answerCardChange('late', true);
    expect(store.notification).toContain('40 cards');
    expect(card('late')).toBeUndefined();
    expect(waitingCardChanges()).toEqual([]);
  });

  it('applies nothing when the user changed or removed the card while the change waited', () => {
    save({ ...RISKS, enabled: true, name: 'Dangers' });
    setStore('cardDefinitions', 1, 'description', 'Edited by the user');
    answerCardChange('risks', true);
    expect(card('risks')).toMatchObject({ name: 'Risks', enabled: false });
    expect(store.notification).toContain('Nothing was applied');

    save({ ...RISKS, enabled: true });
    setStore('cardDefinitions', [confidenceCard(false)]);
    answerCardChange('risks', true);
    expect(ids()).toEqual(['confidence']);
  });

  it('applies nothing when what it deletes is no longer what the user was told', () => {
    setStore('tasks', 't1', 'cards', { risks: { values: { top: TOP_VALUE }, at: 1 } });
    save({ ...RISKS, slots: [RISKS.slots[1]] });
    setStore('tasks', 't2', 'cards', { risks: { values: { top: TOP_VALUE }, at: 1 } });
    answerCardChange('risks', true);
    expect(card('risks')?.slots).toHaveLength(2);
    expect(store.tasks.t2.cards?.risks.values).toEqual({ top: TOP_VALUE });

    remove('risks');
    setStore('tasks', 't2', 'cards', undefined);
    answerCardChange('risks', true);
    expect(ids()).toEqual(['confidence', 'risks']);
    expect(store.notification).toContain('Nothing was applied');
  });

  it('refuses more waiting changes than the user can be asked about', () => {
    for (let n = 0; n < 5; n++) save({ ...RISKS, id: `ai-${n}`, enabled: true });
    expect(() => save({ ...RISKS, id: 'ai-5', enabled: true })).toThrow('waiting for a click');
    expect(waitingCardChanges()).toHaveLength(5);
  });
});
