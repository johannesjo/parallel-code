import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appFactCard } from '../../lib/app-facts';
import { setStore, store } from '../../store/core';
import type { Task } from '../../store/types';
import { PinRow } from './PinRow';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  vi.useRealTimers();
  setStore('cardDefinitions', []);
});

describe('PinRow', () => {
  it('keeps a pinned time current while nothing else changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    setStore('cardDefinitions', [{ ...appFactCard('activity', true), pinned: ['last'] }]);
    setStore('tasks', {
      t1: {
        id: 't1',
        projectId: 'p1',
        agentIds: [],
        shellAgentIds: [],
        promptHistory: [{ text: 'go', sentAt: Date.now() }],
      } as unknown as Task,
    });
    dispose = render(() => <PinRow task={store.tasks.t1} />, document.body);
    const before = document.querySelector('.pin-row')?.textContent;
    vi.advanceTimersByTime(5 * 60_000);
    expect(document.querySelector('.pin-row')?.textContent).not.toBe(before);
  });

  it('opens a card from its pinned values', () => {
    setStore('cardDefinitions', [{ ...appFactCard('activity', true), pinned: ['last'] }]);
    setStore('tasks', {
      t1: { id: 't1', projectId: 'p1', agentIds: [], shellAgentIds: [] } as unknown as Task,
    });
    const onOpenCard = vi.fn();
    dispose = render(() => <PinRow task={store.tasks.t1} onOpenCard={onOpenCard} />, document.body);
    document.querySelector<HTMLButtonElement>('.pin-row button')?.click();
    expect(onOpenCard).toHaveBeenCalledWith('activity');
  });
});
