import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { mockRequest, mockInvoke } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockInvoke: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('../../lib/model-request', () => ({ startModelRequest: mockRequest }));
vi.mock('../../lib/ipc', () => ({ invoke: mockInvoke }));
vi.mock('../../store/check-suite-state', () => ({
  getTaskChecks: () => [{ id: 'verify', name: 'Check', kind: 'static', command: 'npm test' }],
}));
vi.mock('../../lib/load-task-diff', () => ({
  loadTaskDiff: () =>
    Promise.resolve({ rawDiff: 'diff --git a/q.ts b/q.ts\n+retry()', cwd: '/wt' }),
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
}));
vi.mock('../../store/projects', () => ({ getProjectPath: () => '/repo' }));

import { IPC } from '../../../electron/ipc/channels';
import type { CardDefinition } from '../../lib/cards';
import { checkCard } from '../../lib/check-card';
import { setStore, store } from '../../store/core';
import type { Task } from '../../store/types';
import { FinishBottomLine, FinishCards } from './FinishCards';

const model = (
  id: string,
  trigger: 'finish' | 'after-turn',
  showAtFinish: boolean,
): CardDefinition => ({
  id,
  name: id === 'note' ? 'Release note' : 'Risks',
  description: '',
  source: { kind: 'model', model: 'default', prompt: 'Write it.', inputs: ['diff'], trigger },
  slots: [{ id: 'text', type: 'text', label: 'Text' }],
  enabled: true,
  ...(showAtFinish && { showAtFinish: true }),
});

let dispose: (() => void) | undefined;
beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockImplementation(() => ({
    result: Promise.resolve('{"text":"Retries back off."}'),
    cancel: vi.fn(),
  }));
  setStore('showCards', true);
  setStore('cardDefinitions', [
    model('note', 'finish', true),
    model('risks', 'after-turn', false),
    checkCard({ id: 'verify', name: 'Check' }),
    {
      id: 'bottom-line',
      name: 'Bottom line',
      description: '',
      source: { kind: 'agent' },
      slots: [{ id: 'verdict', type: 'line', label: 'Verdict' }],
      enabled: true,
      showAtFinish: true,
    },
  ]);
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
      promptHistory: [{ text: 'add retries', sentAt: 10 }],
    } as unknown as Task,
  });
  dispose = render(() => <FinishCards task={store.tasks.t1} />, document.body);
});
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

it('shows only cards marked for Finish', () => {
  const names = [...document.body.querySelectorAll('section.card')].map((s) =>
    s.getAttribute('aria-label'),
  );
  expect(names).toEqual(['Release note', 'Check']);
});

it('fills Finish-triggered cards once when it opens, and no others', async () => {
  await vi.waitFor(() => expect(document.body.textContent).toContain('Retries back off.'));
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(store.tasks.t1.cards?.risks).toBeUndefined();
});

it('runs the check cards set to run at Finish when it opens', async () => {
  await vi.waitFor(() =>
    expect(mockInvoke).toHaveBeenCalledWith(
      IPC.RunCardCheck,
      expect.objectContaining({ command: 'npm test' }),
    ),
  );
});

it('leaves the Bottom line card to the top of the dialog once the agent filled it', () => {
  setStore('tasks', 't1', 'cards', {
    'bottom-line': { values: { verdict: { type: 'line', text: 'Ready to merge.' } }, at: 1 },
  });
  const top = document.createElement('div');
  document.body.append(top);
  const disposeTop = render(() => <FinishBottomLine task={store.tasks.t1} />, top);
  try {
    const names = [...top.querySelectorAll('section.card')].map((s) =>
      s.getAttribute('aria-label'),
    );
    expect(names).toEqual(['Bottom line']);
  } finally {
    disposeTop();
  }
});

it('shows no Bottom line while that card is not marked for Finish', () => {
  setStore('cardDefinitions', (cards) =>
    cards.map((card) => (card.id === 'bottom-line' ? { ...card, showAtFinish: false } : card)),
  );
  const top = document.createElement('div');
  document.body.append(top);
  const disposeTop = render(() => <FinishBottomLine task={store.tasks.t1} />, top);
  try {
    expect(top.querySelector('section.card')).toBeNull();
  } finally {
    disposeTop();
  }
});

it('shows no Bottom line before the agent filled it, so the merge options stay put', () => {
  const top = document.createElement('div');
  document.body.append(top);
  const disposeTop = render(() => <FinishBottomLine task={store.tasks.t1} />, top);
  try {
    expect(top.querySelector('section.card')).toBeNull();
  } finally {
    disposeTop();
  }
});
