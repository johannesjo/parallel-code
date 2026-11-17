import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardDefinition } from '../../lib/cards';

const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));
vi.mock('../../lib/model-request', () => ({ startModelRequest: mockRequest }));
vi.mock('../../lib/load-task-diff', () => ({
  loadTaskDiff: () => Promise.resolve({ rawDiff: 'diff --git a/x b/x\n+y', cwd: '/wt' }),
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
}));

import { setStore, store } from '../../store/core';
import { CardView } from './CardView';

function card(trigger: 'manual' | 'after-turn'): CardDefinition {
  return {
    id: 'next',
    name: 'Next step',
    description: '',
    source: { kind: 'model', model: 'default', prompt: 'Say.', inputs: ['diff'], trigger },
    slots: [{ id: 'now', type: 'line', label: 'Next' }],
    enabled: true,
  };
}

let dispose: (() => void) | undefined;
beforeEach(() => {
  mockRequest.mockReset();
  setStore('showCards', true);
  setStore('tasks', {
    t1: { id: 't1', projectId: 'p1', worktreePath: '/wt', gitIsolation: 'none', agentIds: [] },
  } as never);
});
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

function show(definition: CardDefinition): void {
  setStore('cardDefinitions', [definition]);
  dispose = render(
    () => <CardView card={definition} task={store.tasks.t1} now={0} />,
    document.body,
  );
}

const button = (name: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent === name);

describe('model card actions', () => {
  it('refreshes a manual card, showing "updating" while it runs', async () => {
    let answer: (text: string) => void = () => {};
    mockRequest.mockImplementation(() => ({
      result: new Promise<string>((resolve) => (answer = resolve)),
      cancel: vi.fn(),
    }));
    show(card('manual'));
    button('Refresh')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('updating'));
    answer('{"now":"Write the migration"}');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Write the migration'));
    expect(document.body.textContent).not.toContain('updating');
  });

  it('shows the error and a Retry that runs it again', async () => {
    mockRequest.mockImplementation(() => ({
      result: Promise.reject(new Error('Rate limited')),
      cancel: vi.fn(),
    }));
    show(card('after-turn'));
    expect(button('Refresh')).toBeUndefined();
    button('Retry')?.click();
    expect(mockRequest).not.toHaveBeenCalled();
    const { runModelCard } = await import('../../store/card-models');
    await runModelCard('t1', 'next', { force: true });
    await vi.waitFor(() =>
      expect(document.querySelector('.card-error-detail')?.textContent).toBe('Rate limited'),
    );
    button('Retry')?.click();
    await vi.waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
  });
});
