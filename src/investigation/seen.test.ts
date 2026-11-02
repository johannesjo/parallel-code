import { describe, expect, it } from 'vitest';
import { acceptUpdate, emptyHistory, type History, type InvestigationUpdate } from './state';
import { changesSince, followSeen } from './seen';

function build(...steps: [InvestigationUpdate['actor'], InvestigationUpdate['operations']][]) {
  return steps.reduce<History>(
    (history, [actor, operations], sequence) =>
      acceptUpdate(history, {
        runId: 'run',
        sequence,
        expectedRevision: history.snapshots.at(-1)?.revision ?? 0,
        actor,
        operations,
      }),
    emptyHistory(),
  );
}

const note = (id: string, title: string, parent?: string) => ({
  type: 'insert' as const,
  node: { id, title, detail: '', ...(parent ? { parent } : {}) },
});

const history = build(
  ['agent', [note('goal', 'Goal'), note('a', 'A', 'goal'), note('b', 'B', 'goal')]],
  ['agent', [note('c', 'C', 'goal'), { type: 'update', id: 'a', changes: { title: 'A2' } }]],
  ['agent', [{ type: 'remove', id: 'b' }]],
  ['user', [note('mine', 'Mine', 'goal'), { type: 'update', id: 'goal', changes: { title: 'G' } }]],
);

describe('changesSince', () => {
  it('marks agent additions and edits since the baseline and lists removals', () => {
    const changes = changesSince(history, 0);
    expect([...changes.marks]).toEqual([
      ['a', 'changed'],
      ['c', 'new'],
    ]);
    expect(changes.removed.map((record) => record.title)).toEqual(['B']);
  });

  it('does not report the user’s own edits', () => {
    const changes = changesSince(history, 2);
    expect(changes.marks.size).toBe(0);
    expect(changes.removed).toEqual([]);
  });

  it('marks everything as new from before the first update', () => {
    const changes = changesSince(history, -1);
    expect(changes.marks.get('goal')).toBe('new');
    expect(changes.marks.get('mine')).toBeUndefined();
    expect(changes.removed).toEqual([]);
  });

  it('lists a removed branch with its descendants but not a node the user deleted', () => {
    const pruned = build(
      ['agent', [note('goal', 'Goal'), note('a', 'A', 'goal'), note('a1', 'A1', 'a')]],
      ['agent', [note('b', 'B', 'goal')]],
      ['agent', [{ type: 'update', id: 'b', changes: { title: 'B2' } }]],
      ['user', [{ type: 'remove', id: 'b' }]],
      ['agent', [{ type: 'remove', id: 'a' }]],
    );
    expect(changesSince(pruned, 1).removed.map((record) => record.id)).toEqual(['a', 'a1']);
  });

  it('ignores an edit the agent reverted', () => {
    const reverted = build(
      ['agent', [note('goal', 'Goal')]],
      ['agent', [{ type: 'update', id: 'goal', changes: { title: 'Other' } }]],
      ['agent', [{ type: 'update', id: 'goal', changes: { title: 'Goal' } }]],
    );
    expect(changesSince(reverted, 0).marks.size).toBe(0);
  });
});

describe('followSeen', () => {
  it('adopts the current state of a run seen for the first time', () => {
    expect(followSeen(undefined, 7, 8)).toBe(7);
  });

  it('follows updates watched live', () => {
    expect(followSeen(3, 5, 4)).toBe(5);
  });

  it('holds the baseline when a catch-up read brought unseen updates', () => {
    expect(followSeen(3, 9, 10)).toBe(3);
  });

  it('resets a baseline beyond the current graph', () => {
    expect(followSeen(12, 4, 5)).toBe(4);
  });
});
