import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../lib/ipc', () => ({ invoke: vi.fn() }));

import type { CardDefinition } from '../../lib/cards';
import { setStore, store } from '../../store/core';
import type { Task } from '../../store/types';
import { CardsPane } from './CardsPane';

const card = (id: string, name: string, warnBelow?: number): CardDefinition => ({
  id,
  name,
  description: '',
  source: { kind: 'agent' },
  slots: [{ id: 'score', type: 'score', label: 'Score', warnBelow }],
  enabled: true,
});

let dispose: (() => void) | undefined;
beforeEach(() => {
  setStore('showCards', true);
  setStore('cardDefinitions', [card('quiet', 'Quiet'), card('loud', 'Loud', 70)]);
  setStore('tasks', {
    t1: {
      id: 't1',
      projectId: 'p1',
      agentIds: ['a1'],
      shellAgentIds: [],
      cards: { loud: { values: { score: { type: 'score', score: 10, why: 'Low.' } }, at: 1 } },
    } as unknown as Task,
  });
  dispose = render(() => <CardsPane task={store.tasks.t1} />, document.body);
});
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  setStore('tasks', {});
  setStore('cardDefinitions', []);
});

it('keeps display order even when a later card needs attention, every card open', () => {
  const cards = () => [...document.body.querySelectorAll('section.card')];
  expect(cards().map((c) => c.getAttribute('aria-label'))).toEqual(['Quiet', 'Loud']);
  expect(document.body.querySelector('[aria-expanded]')).toBeNull();
  expect(cards()[1].textContent).toContain('Low.');
});

it('offers an icon-only Update now only while a model card is enabled', () => {
  const update = () => document.body.querySelector('button[aria-label="Update now"]');
  expect(update()).toBeNull();
  setStore('cardDefinitions', 0, 'source', {
    kind: 'model',
    model: 'default',
    prompt: 'Rate it.',
    inputs: ['diff'],
    trigger: 'manual',
  });
  // An icon beside the Edit cards pencil; its name is in the label and the tooltip.
  expect(update()?.textContent).toBe('');
  expect(update()?.getAttribute('title')).toBe('Update now');
  expect(update()?.querySelector('svg')).not.toBeNull();
});

it('opens Settings › Cards from an icon-only Edit cards button', () => {
  const edit = document.body.querySelector<HTMLButtonElement>('button[aria-label="Edit cards"]');
  if (!edit) throw new Error('No Edit cards button');
  expect(edit.textContent).toBe('');
  edit.click();
  expect(store.showSettingsDialog).toBe(true);
  expect(store.settingsTabRequest).toBe('cards');
});

it('leaves out a card set to hide until it has values, then shows it once it has some', () => {
  const names = () =>
    [...document.body.querySelectorAll('section.card')].map((c) => c.getAttribute('aria-label'));
  setStore('cardDefinitions', 0, 'hideEmpty', true);
  expect(names()).toEqual(['Loud']);
  setStore('tasks', 't1', 'cards', 'quiet', {
    values: { score: { type: 'score', score: 90, why: 'Fine.' } },
    at: 2,
  });
  expect(names()).toEqual(['Quiet', 'Loud']);
});

it('says the cards fill in when every card is hidden until it has values', () => {
  setStore('cardDefinitions', [{ ...card('quiet', 'Quiet'), hideEmpty: true }]);
  expect(document.body.querySelector('section.card')).toBeNull();
  expect(document.body.textContent).toContain('Cards fill in as you work');
});
