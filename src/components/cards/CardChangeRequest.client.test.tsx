import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../lib/ipc', () => ({ invoke: vi.fn() }));

import { confidenceCard, type CardDefinition } from '../../lib/cards';
import { answerCardChange, changeCardConfig, waitingCardChanges } from '../../store/card-config';
import { setStore, store } from '../../store/core';
import type { Task } from '../../store/types';
import { CardChangeRequest } from './CardChangeRequest';

const RISKS: CardDefinition = {
  id: 'risks',
  name: 'Risks',
  description: '',
  source: {
    kind: 'model',
    model: 'sonnet',
    prompt: 'List.',
    inputs: ['diff'],
    trigger: 'after-turn',
  },
  slots: [{ id: 'top', type: 'line', label: 'Top risk' }],
  enabled: false,
};

const notice = () => document.querySelector('[role="region"]');
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((entry) => entry.textContent === label);

let dispose: (() => void) | undefined;
beforeEach(() => {
  setStore('projects', []);
  setStore('cardDefinitions', [confidenceCard(false), structuredClone(RISKS)]);
  setStore('tasks', { t1: { id: 't1', name: 'Fix login', projectId: 'p1' } as unknown as Task });
  dispose = render(() => <CardChangeRequest />, document.body);
});
afterEach(() => {
  for (const waiting of waitingCardChanges()) answerCardChange(waiting.cardId, false);
  dispose?.();
  document.body.replaceChildren();
  setStore('tasks', {});
  setStore('cardDefinitions', []);
});

it('shows nothing while no change is waiting', () => {
  expect(notice()).toBeNull();
});

it('says who asks for what, and applies it on one click', () => {
  changeCardConfig('t1', { action: 'save', card: { ...RISKS, enabled: true } });
  expect(notice()?.textContent).toContain(
    '"Fix login" wants to change "Risks", which switches on an AI card (Sonnet, after each turn, sends the diff).',
  );
  button('Apply')?.click();
  expect(store.cardDefinitions[1].enabled).toBe(true);
  expect(notice()).toBeNull();
});

it('leaves the cards alone when dismissed, and moves on to the next change', () => {
  changeCardConfig('t1', { action: 'save', card: { ...RISKS, enabled: true } });
  changeCardConfig('t1', {
    action: 'save',
    card: { ...RISKS, id: 'more', name: 'More', enabled: true },
  });
  expect(notice()?.textContent).toContain('1 more waiting');
  button('Dismiss')?.click();
  expect(store.cardDefinitions[1].enabled).toBe(false);
  expect(notice()?.textContent).toContain('wants to add "More"');
  expect(notice()?.textContent).not.toContain('more waiting');
});
