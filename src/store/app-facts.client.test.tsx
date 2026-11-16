import { afterEach, describe, expect, it } from 'vitest';
import { appFactCard } from '../lib/app-facts';
import { cardTaskState } from './app-facts';
import { setStore } from './core';
import type { Task } from './types';

const TASK = {
  id: 't1',
  projectId: 'p1',
  agentIds: [],
  cards: { notes: { at: 1, values: { note: { type: 'line', text: 'kept' } } } },
  facts: { diff: { added: 3, removed: 1, files: 2, at: 9 } },
} as unknown as Task;

afterEach(() => setStore('cardDefinitions', []));

describe('cardTaskState', () => {
  it("adds an enabled app card's values to the task's own", () => {
    setStore('cardDefinitions', [appFactCard('diff-size', true), appFactCard('commits', true)]);
    const state = cardTaskState(TASK, 10);
    expect(state.cards?.notes).toEqual(TASK.cards?.notes);
    expect(state.cards?.['diff-size']?.values.lines).toEqual({ type: 'line', text: '+3 −1' });
    // No commit count read yet: the card waits instead of showing zero.
    expect(state.cards).not.toHaveProperty('commits');
  });

  it('leaves the task as it is while no app card is on', () => {
    setStore('cardDefinitions', [appFactCard('diff-size', false)]);
    expect(cardTaskState(TASK, 10)).toBe(TASK);
  });
});
