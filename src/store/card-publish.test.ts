import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLoadTaskDiff } = vi.hoisted(() => ({ mockLoadTaskDiff: vi.fn() }));

vi.mock('../lib/load-task-diff', () => ({
  loadTaskDiff: mockLoadTaskDiff,
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
}));
vi.mock('./projects', () => ({ getProjectPath: () => '/repo' }));

import { confidenceCard, type CardDefinition } from '../lib/cards';
import { diffFingerprint } from '../lib/diff-excerpt';
import { listAgentCards, publishCardValues } from './card-publish';
import { store, setStore } from './core';
import type { Task } from './types';

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+change';
const NOTES: CardDefinition = {
  id: 'notes',
  name: 'Notes',
  description: 'What the agent wants you to know',
  source: { kind: 'agent' },
  slots: [{ id: 'note', type: 'line', label: 'Note' }],
  enabled: true,
};
const CI: CardDefinition = {
  id: 'ci',
  name: 'CI',
  description: '',
  source: { kind: 'app', fact: 'ci' },
  slots: [{ id: 'runs', type: 'status', label: 'Runs' }],
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadTaskDiff.mockResolvedValue({ rawDiff: DIFF, cwd: '/wt' });
  setStore('showCards', true);
  setStore('cardDefinitions', [
    confidenceCard(true),
    structuredClone(NOTES),
    structuredClone(CI),
    { ...structuredClone(NOTES), id: 'elsewhere', projects: { p1: false } },
  ]);
  setStore('tasks', {
    t1: {
      id: 't1',
      name: 'Fix login',
      projectId: 'p1',
      worktreePath: '/wt',
      gitIsolation: 'worktree',
      agentIds: ['agent-1'],
    } as unknown as Task,
  });
});

describe('listAgentCards', () => {
  it("lists Confidence, then the agent cards on in the task's project", () => {
    const { cards } = listAgentCards('t1');
    expect(cards.map((card) => card.card)).toEqual(['confidence', 'notes']);
  });

  it('refuses a task that is gone', () => {
    expect(() => listAgentCards('gone')).toThrow('Task not available.');
  });
});

describe('publishCardValues', () => {
  it('stores the values and dates them by the code they describe', async () => {
    publishCardValues('t1', 'notes', { note: 'Ready for review' });
    expect(store.tasks.t1.cards?.notes?.values).toEqual({
      note: { type: 'line', text: 'Ready for review' },
    });
    await vi.waitFor(() =>
      expect(store.tasks.t1.cards?.notes?.fingerprint).toBe(diffFingerprint(DIFF)),
    );
  });

  it('adds up items across publishes, tagged with the turn each came in', () => {
    setStore('cardDefinitions', 1, 'slots', [
      { id: 'todo', type: 'items', label: 'Follow-ups', addUp: true },
    ]);
    setStore('tasks', 't1', 'promptHistory', [{ text: 'one', sentAt: 1 }] as never);
    publishCardValues('t1', 'notes', { todo: ['Rename flag'] });
    setStore('tasks', 't1', 'promptHistory', [
      { text: 'one', sentAt: 1 },
      { text: 'two', sentAt: 2 },
    ] as never);
    publishCardValues('t1', 'notes', { todo: ['Add docs', 'rename flag'] });
    expect(store.tasks.t1.cards?.notes?.values.todo).toEqual({
      type: 'items',
      items: [
        { text: 'Add docs', severity: 'info', turn: 2 },
        { text: 'Rename flag', severity: 'info', turn: 1 },
      ],
    });
  });

  it('keeps the previous values when a slot does not fit', () => {
    publishCardValues('t1', 'notes', { note: 'First' });
    expect(() => publishCardValues('t1', 'notes', { note: 'x'.repeat(5_000) })).toThrow(
      /Slot "note" is too large/,
    );
    expect(store.tasks.t1.cards?.notes?.values.note).toEqual({ type: 'line', text: 'First' });
  });

  it('refuses cards the agent does not fill here', () => {
    expect(() => publishCardValues('t1', 'ci', { runs: [] })).toThrow(/not by the agent/);
    expect(() => publishCardValues('t1', 'elsewhere', { note: 'x' })).toThrow(/is off/);
    expect(() => publishCardValues('t1', 'missing', { note: 'x' })).toThrow(/no card "missing"/);
    // Confidence takes ratings, checked as confidence_publish checks them.
    expect(() => publishCardValues('t1', 'confidence', { scores: [] })).toThrow(/scores must be/);
    expect(store.tasks.t1.cards).toBeUndefined();
  });
});
