import { expect, it } from 'vitest';
import { lastAgentUpdateTouching, transcriptKey } from './transcript';
import type { InvestigationUpdate } from './state';

const update = (
  sequence: number,
  actor: 'agent' | 'user',
  operations: InvestigationUpdate['operations'],
): InvestigationUpdate => ({
  runId: 'run',
  sequence,
  actor,
  operations,
  expectedRevision: sequence,
});

const updates = [
  update(0, 'agent', [
    { type: 'insert', node: { id: 'goal', title: 'Goal', detail: '' } },
    { type: 'insert', node: { id: 'h1', parent: 'goal', title: 'H1', detail: '' } },
  ]),
  update(1, 'agent', [
    { type: 'insert', node: { id: 'obs', parent: 'h1', title: 'Obs', detail: '' } },
    {
      type: 'insert_relation',
      relation: { id: 'l1', source: 'obs', target: 'h1', kind: 'supports', rationale: 'r' },
    },
  ]),
  update(2, 'user', [{ type: 'update', id: 'h1', changes: { title: 'Edited' } }]),
  update(3, 'agent', [{ type: 'move', id: 'obs', parent: 'goal' }]),
];

it('finds the last agent update that inserted, changed, moved or linked a record', () => {
  expect(lastAgentUpdateTouching(updates, 'goal')).toBe(0);
  expect(lastAgentUpdateTouching(updates, 'h1')).toBe(1);
  expect(lastAgentUpdateTouching(updates, 'obs')).toBe(3);
  expect(lastAgentUpdateTouching(updates, 'missing')).toBeUndefined();
  expect(lastAgentUpdateTouching([], 'goal')).toBeUndefined();
});

it('keys reasoning marks apart from step marks', () => {
  expect(transcriptKey(4)).toBe('reasoning:4');
});
