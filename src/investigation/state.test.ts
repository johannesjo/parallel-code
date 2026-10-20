import { describe, expect, it } from 'vitest';
import { acceptUpdate, emptyHistory, recordEmphasis, snapshotAt } from './state';

import { makeFixture } from './fixture';
import { recordTrail, noteTypes } from './presentation';

describe('investigation replay', () => {
  it('preserves earlier interpretations and accepts corrections through explicit patches', () => {
    const history = makeFixture();
    const before = history.snapshots[8];
    const corrected = acceptUpdate(history, {
      runId: history.updates[0].runId,
      sequence: history.updates.length,
      expectedRevision: before.revision,
      actor: 'agent',
      operations: [
        {
          type: 'update_relation',
          id: 'E21-H2',
          changes: { rationale: 'Reassessed with new evidence' },
        },
      ],
    });
    expect(snapshotAt(corrected, 8)).toEqual(before);
    expect(corrected.snapshots[9].relations.find((link) => link.id === 'E21-H2')?.rationale).toBe(
      'Reassessed with new evidence',
    );
    expect(corrected.snapshots[9].records).toEqual(before.records);
  });
  it('retypes and moves existing notes while preserving IDs and earlier history', () => {
    const history = makeFixture();
    const changed = acceptUpdate(history, {
      runId: history.updates[0].runId,
      sequence: history.updates.length,
      expectedRevision: history.snapshots[8].revision,
      actor: 'agent',
      operations: [
        { type: 'update', id: 'H1', changes: { kind: 'question' } },
        { type: 'move', id: 'H1', parent: 'G1' },
      ],
    });
    expect(changed.snapshots[9].records.find((node) => node.id === 'H1')).toMatchObject({
      kind: 'question',
      parent: 'G1',
    });
    expect(history.snapshots[8].records.find((node) => node.id === 'H1')?.kind).toBe('hypothesis');
  });
});

describe('investigation attention', () => {
  const history = makeFixture();
  it('retains the last work item when updates clear active work', () => {
    expect(history.snapshots[7].activeId).toBe('T5');
    expect(history.snapshots[8].activeId).toBeUndefined();
    expect(history.snapshots[8].lastActiveId).toBe('T5');
    expect(
      acceptUpdate(emptyHistory(), { ...history.updates[0], activeId: undefined }).snapshots[0]
        .lastActiveId,
    ).toBeUndefined();
  });
  it('highlights the declared work and its ancestry, not sibling branches', () => {
    const emphasis = recordEmphasis(history.snapshots[7]);
    expect(emphasis.get('T5')).toBe('working');
    for (const id of ['BUG', 'H2', 'H22']) expect(emphasis.get(id)).toBe('path');
    for (const id of ['H1', 'H3', 'H21', 'E21']) expect(emphasis.get(id)).toBe('background');
    expect(emphasis.get('T4')).toBe('settled');
  });
  it('mutes completed/rejected records but restores a reopened hypothesis', () => {
    const before = recordEmphasis(history.snapshots[5]);
    expect(before.get('T4')).toBe('settled');
    expect(before.get('H22')).toBe('settled');
    expect(recordEmphasis(history.snapshots[6]).get('H22')).toBe('working');
  });
  it('does not invent an active path when no work is declared or work is complete', () => {
    const snapshot = history.snapshots[8];
    const emphasis = recordEmphasis(snapshot);
    expect(emphasis.get('H1')).toBe('normal');
    expect(emphasis.get('E23')).toBe('normal');
    expect(emphasis.get('T5')).toBe('settled');
    expect([...recordEmphasis({ ...snapshot, activeId: 'T5' }).values()]).not.toContain('working');
  });
});

it('connects typed notes to the goal and keeps outcomes attached to work', () => {
  const snapshot = makeFixture().snapshots[5];
  expect(recordTrail(snapshot, 'W8').map((r) => r.kind)).toEqual([
    'goal',
    'question',
    'hypothesis',
    'decision',
    'work',
  ]);
  expect(snapshot.records.find((r) => r.id === 'G1')?.criteria).toHaveLength(3);
  expect(snapshot.records.find((r) => r.id === 'T4')?.result).toContain('Two rows');
  expect(new Set(Object.values(noteTypes).map((type) => type.label)).size).toBe(8);
});
