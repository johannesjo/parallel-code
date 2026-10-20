import { expect, it } from 'vitest';
import { parseReasoningUpdate, parseReasoningFeed } from './reasoning-feed.js';
import { acceptUpdate, emptyHistory, type InvestigationUpdate } from './reasoning-state.js';
const first: InvestigationUpdate = {
  runId: 'run',
  actor: 'agent',
  sequence: 0,
  expectedRevision: 0,
  caption: 'Started',
  activeId: 'goal',
  operations: [
    {
      type: 'insert',
      node: { id: 'goal', kind: 'goal', status: 'unresolved', title: 'Goal', detail: '' },
    },
  ],
};
const encode = (events: InvestigationUpdate[]) =>
  events.map((event) => JSON.stringify(event) + '\n').join('');
it('replays user and agent operations into exactly one current graph and immutable history', () => {
  const user: InvestigationUpdate = {
    runId: 'run',
    actor: 'user',
    sequence: 1,
    expectedRevision: 1,
    operations: [{ type: 'update', id: 'goal', changes: { title: 'User goal' } }],
  };
  const agent: InvestigationUpdate = {
    runId: 'run',
    actor: 'agent',
    sequence: 2,
    expectedRevision: 2,
    operations: [
      {
        type: 'insert_explanation',
        explanation: { id: 'answer', nodeId: 'goal', question: 'Why?', answer: 'Because.' },
      },
    ],
  };
  const events = [first, user, agent];
  const replayed = parseReasoningFeed(encode(events));
  expect(replayed.error).toBeUndefined();
  expect(replayed.history).toEqual(
    events.reduce((history, event) => acceptUpdate(history, event), emptyHistory()),
  );
  expect(replayed.history.snapshots[2]).toMatchObject({
    revision: 3,
    sequence: 2,
    caption: 'Started',
    activeId: 'goal',
    records: [{ title: 'User goal', userEdited: ['title'] }],
  });
  expect(replayed.history.snapshots[0].records[0].title).toBe('Goal');
});
it('replays a feed whose relations predate the duplicate check and still accepts new updates', () => {
  const relation = (id: string): InvestigationUpdate['operations'][number] => ({
    type: 'insert_relation',
    relation: { id, source: 'clue', target: 'goal', kind: 'supports', rationale: 'Seen.' },
  });
  const clue: InvestigationUpdate = {
    ...first,
    sequence: 1,
    expectedRevision: 1,
    operations: [
      {
        type: 'insert',
        node: {
          id: 'clue',
          parent: 'goal',
          kind: 'observation',
          status: 'unresolved',
          title: 'Clue',
          detail: '',
        },
      },
      relation('one'),
    ],
  };
  const stale: InvestigationUpdate = {
    ...first,
    sequence: 2,
    expectedRevision: 2,
    operations: [relation('two')],
  };
  const replayed = parseReasoningFeed(encode([first, clue, stale]));
  expect(replayed.error).toBeUndefined();
  expect(replayed.history.snapshots[2].relations).toHaveLength(2);
  expect(() => acceptUpdate(replayed.history, stale)).not.toThrow();
  expect(() =>
    acceptUpdate(replayed.history, {
      ...first,
      sequence: 3,
      expectedRevision: 3,
      operations: [relation('three')],
    }),
  ).toThrow('duplicates link');
  const unknownKind = relation('four');
  if (unknownKind.type === 'insert_relation') unknownKind.relation.kind = 'causes';
  // The agent must learn from the rejection which kinds exist.
  expect(() =>
    acceptUpdate(replayed.history, {
      ...first,
      sequence: 3,
      expectedRevision: 3,
      operations: [unknownKind],
    }),
  ).toThrow('supports, challenges or fits');
  expect(
    acceptUpdate(replayed.history, {
      ...first,
      sequence: 3,
      expectedRevision: 3,
      operations: [{ type: 'update', id: 'goal', changes: { title: 'Still editable' } }],
    }).snapshots[3].records[0].title,
  ).toBe('Still editable');
});

it('keeps the last valid graph after incomplete, invalid, truncated or rewritten data', () => {
  const raw = encode([first]);
  const previous = parseReasoningFeed(raw).history;
  expect(parseReasoningFeed(raw + '{', previous)).toMatchObject({
    history: previous,
    pending: true,
  });
  expect(parseReasoningFeed(raw + '{}\n', previous).history).toEqual(previous);
  expect(parseReasoningFeed('', previous).history).toEqual(previous);
  expect(
    parseReasoningFeed(encode([{ ...first, caption: 'rewritten' }]), previous).error,
  ).toContain('history');
});
it('requires exact event ordering and accepts identical replay', () => {
  expect(parseReasoningFeed(encode([{ ...first, sequence: 1 }])).error).toContain('sequence');
  expect(parseReasoningFeed(encode([first, first])).history.updates).toHaveLength(1);
  expect(
    parseReasoningFeed(encode([first, { ...first, sequence: 1, runId: 'another' }])).error,
  ).toContain('run');
});
it('clears activity explicitly and preserves it on a user title save', () => {
  const history = acceptUpdate(emptyHistory(), first);
  const stopped = acceptUpdate(history, {
    runId: 'run',
    actor: 'agent',
    sequence: 1,
    expectedRevision: 1,
    operations: [],
    activeId: null,
  });
  expect(stopped.snapshots[1].activeId).toBeUndefined();
  expect(stopped.snapshots[1].lastActiveId).toBe('goal');
});
it.each([
  { actor: 'user' },
  { sequence: 0 },
  { records: [] },
  { expectedRevision: -1 },
  { runId: '__proto__' },
  { runId: 'run', newRunId: 'run' },
  { activeId: '../escape' },
])('rejects legacy, unsafe and authority-bearing commands %j', (extra) => {
  expect(() =>
    parseReasoningUpdate({ runId: 'run', expectedRevision: 1, operations: [], ...extra }),
  ).toThrow();
});
it('accepts a fresh-run command based on the old graph revision', () => {
  expect(
    parseReasoningUpdate({
      runId: 'old',
      newRunId: 'new',
      expectedRevision: 8,
      operations: first.operations,
    }),
  ).toMatchObject({ runId: 'old', newRunId: 'new', expectedRevision: 8 });
});
it('treats an in-memory update and its re-parsed form as the same history entry', () => {
  const reordered = JSON.parse(
    JSON.stringify({
      operations: first.operations,
      activeId: first.activeId,
      caption: first.caption,
      expectedRevision: first.expectedRevision,
      sequence: first.sequence,
      actor: first.actor,
      runId: first.runId,
    }),
  ) as InvestigationUpdate;
  const history = acceptUpdate(emptyHistory(), first);
  expect(acceptUpdate(history, reordered)).toBe(history);
  const replayed = parseReasoningFeed(encode([reordered]), history);
  expect(replayed.error).toBeUndefined();
  expect(replayed.history).toBe(history);
});
