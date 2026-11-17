import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));
vi.mock('../../lib/model-request', () => ({ startModelRequest: mockRequest }));
vi.mock('../../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../../lib/load-task-diff', () => ({
  loadTaskDiff: () =>
    Promise.resolve({ rawDiff: 'diff --git a/q.ts b/q.ts\n+retry()', cwd: '/wt' }),
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
}));
vi.mock('../../store/projects', () => ({ getProjectPath: () => '/repo' }));

import type { CardDefinition } from '../../lib/cards';
import { setStore, store } from '../../store/core';
import type { Task } from '../../store/types';
import { CardsPopover, UpdateCardsButton } from './CardsPopover';

const NOTE: CardDefinition = {
  id: 'note',
  name: 'Release note',
  description: '',
  source: {
    kind: 'model',
    model: 'default',
    prompt: 'Write it.',
    inputs: ['diff'],
    trigger: 'manual',
  },
  slots: [{ id: 'text', type: 'text', label: 'Text' }],
  enabled: true,
};
const DIFF: CardDefinition = {
  id: 'diff-size',
  name: 'Diff size',
  description: '',
  source: { kind: 'app', fact: 'diff-size' },
  slots: [{ id: 'lines', type: 'line', label: 'Lines' }],
  enabled: true,
};

let dispose: (() => void) | undefined;
beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockImplementation(() => ({
    result: Promise.resolve('{"text":"Retries back off."}'),
    cancel: vi.fn(),
  }));
  setStore('showCards', true);
  setStore('cardDefinitions', [NOTE, DIFF]);
  setStore('tasks', {
    t1: {
      id: 't1',
      name: 'Retry webhooks',
      projectId: 'p1',
      worktreePath: '/wt',
      gitIsolation: 'worktree',
      baseBranch: 'main',
      agentIds: [],
      shellAgentIds: [],
      promptHistory: [],
    } as unknown as Task,
  });
  dispose = render(
    () => (
      <CardsPopover
        task={store.tasks.t1}
        open
        anchor={() => undefined}
        panelRef={() => undefined}
        onClose={() => undefined}
      />
    ),
    document.body,
  );
});
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

it('says how many cards use a model and updates them all on request', async () => {
  expect(document.body.textContent).toContain('2 cards · 1 use a model');
  const update = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent === 'Update now',
  );
  if (!update) throw new Error('No Update now button');
  update.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Retries back off.'));
  expect(mockRequest).toHaveBeenCalledTimes(1);
});

it('greys the icon-only Update now while the cards update, then offers it again', async () => {
  let reply: (text: string) => void = () => {};
  mockRequest.mockImplementation(() => ({
    result: new Promise<string>((resolve) => (reply = resolve)),
    cancel: vi.fn(),
  }));
  const host = document.body.appendChild(document.createElement('div'));
  const disposeIcon = render(
    () => <UpdateCardsButton task={store.tasks.t1} cards={store.cardDefinitions} iconOnly />,
    host,
  );
  const icon = host.querySelector<HTMLButtonElement>('button[aria-label="Update now"]');
  if (!icon) throw new Error('No Update now icon');
  expect(icon.disabled).toBe(false);
  icon.click();
  await vi.waitFor(() => expect(icon.disabled).toBe(true));
  reply('{"text":"Retries back off."}');
  await vi.waitFor(() => expect(icon.disabled).toBe(false));
  expect(mockRequest).toHaveBeenCalledTimes(1);
  disposeIcon();
});

it('shows every card open, the ones needing attention first', () => {
  const score: CardDefinition = {
    id: 'score',
    name: 'Score',
    description: '',
    source: { kind: 'agent' },
    slots: [{ id: 'q', type: 'score', label: 'Quality', warnBelow: 70 }],
    enabled: true,
  };
  setStore('cardDefinitions', [NOTE, score]);
  setStore('tasks', 't1', 'cards', {
    note: { values: { text: { type: 'text', text: 'Retries back off.' } }, at: 1 },
    score: { values: { q: { type: 'score', score: 10, why: 'Low.' } }, at: 1 },
  });
  const names = [...document.body.querySelectorAll('.cards-popover section.card')].map((c) =>
    c.getAttribute('aria-label'),
  );
  expect(names).toEqual(['Score', 'Release note']);
  expect(document.body.querySelector('.cards-popover [aria-expanded]')).toBeNull();
  const popover = document.body.querySelector('.cards-popover');
  expect(popover?.textContent).toContain('Low.');
  expect(popover?.textContent).toContain('Retries back off.');
});
