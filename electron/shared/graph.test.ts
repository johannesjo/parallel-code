import { expect, it } from 'vitest';
import {
  applyMapOperations,
  graphDifference,
  parseGraphUpdate,
  validateGraph,
  type GraphDocument,
  type MapOperation,
} from './graph.js';
import { GRAPH_LIMITS, GRAPH_MAX_BYTES } from './graph-limits.js';

const base = (): GraphDocument => ({
  version: 1,
  revision: 0,
  records: [
    { id: 'root', title: 'Goal', detail: '' },
    {
      id: 'hyp',
      parent: 'root',
      title: 'Hypothesis',
      detail: 'Original',
      kind: 'hypothesis',
      confidence: 0.6,
      sources: [{ label: 'Test', path: 'tests/a.ts', line: 2 }],
    },
    { id: 'leaf', parent: 'hyp', title: 'Child', detail: '' },
    { id: 'peer', parent: 'root', title: 'Peer', detail: '' },
  ],
  relations: [{ id: 'link', source: 'leaf', target: 'peer', kind: 'supports' }],
});
const agent = (graph: GraphDocument, operations: MapOperation[]) =>
  applyMapOperations(
    graph,
    parseGraphUpdate({ expectedRevision: graph.revision, operations }).operations,
    graph.revision,
    'agent',
  );

it.each(['repo', '7c762f5d-4e21-4d66-a689-54ff6d6b1470', '01K5A7M8W4X2R9H3N6Q0T1V2YZ'])(
  'rejects unknown operation types before checking unrelated IDs (%s)',
  (id) => {
    expect(() =>
      parseGraphUpdate({
        expectedRevision: 0,
        operations: [{ type: 'insert_node', node: { id, title: 'Repository' } }],
      }),
    ).toThrow('Unknown graph operation at operations[0].type. Use one of: insert, update');
  },
);

it.each([
  [
    { type: 'insert', node: { id: 'repo', title: 'Repository', summary: 'Content' } },
    'Unknown graph field: "summary". Allowed fields: id, parent, title, detail',
  ],
  [
    { type: 'insert_relation', relation: { id: 'link', fromId: 'artifact', toId: 'repo' } },
    'Unknown graph field: "fromId", "toId". Allowed fields: id, source, target',
  ],
  [
    { type: 'insert', node: { id: 'repo', title: 'Repository', detail: '', kind: 'claim' } },
    'Invalid node kind. Use one of: idea, goal, question',
  ],
  [
    {
      type: 'insert',
      node: { id: 'repo', title: 'Repository', detail: '', kind: 'goal', status: 'accepted' },
    },
    'Invalid status. Use one of: untested, unresolved',
  ],
])('reports accepted fields and enums for malformed operations', (operation, message) => {
  expect(() => parseGraphUpdate({ expectedRevision: 0, operations: [operation] })).toThrow(message);
});

it('patches only supplied fields, explicitly clears optional data and validates kind changes atomically', () => {
  const graph = base();
  const next = agent(graph, [{ type: 'update', id: 'hyp', changes: { confidence: 0.9 } }]);
  expect(next.records[1]).toMatchObject({
    detail: 'Original',
    confidence: 0.9,
    sources: graph.records[1].sources,
  });
  expect(() => agent(next, [{ type: 'update', id: 'hyp', changes: { kind: 'question' } }])).toThrow(
    'hypotheses',
  );
  const retyped = agent(next, [
    { type: 'update', id: 'hyp', changes: { kind: 'question', confidence: null } },
  ]);
  expect(retyped.records[1].confidence).toBeUndefined();
  expect(retyped.records[1].sources).toEqual(graph.records[1].sources);
  expect(graph.records[1].confidence).toBe(0.6);
});

it('rejects stale revisions and leaves the input untouched after a failed batch', () => {
  const graph = base();
  expect(() => applyMapOperations(graph, [], 9)).toThrow('changed');
  expect(() =>
    agent(graph, [
      { type: 'update', id: 'root', changes: { title: 'Changed' } },
      { type: 'move', id: 'hyp', parent: 'leaf' },
    ]),
  ).toThrow('itself');
  expect(graph).toEqual(base());
});

it('protects saved user fields but permits unrelated agent patches and explicit overrides', () => {
  const saved = applyMapOperations(base(), [
    { type: 'update', id: 'hyp', changes: { title: 'User title' } },
  ]);
  expect(saved.records[1].userEdited).toEqual(['title']);
  expect(() =>
    agent(saved, [{ type: 'update', id: 'hyp', changes: { title: 'Agent title' } }]),
  ).toThrow('protected');
  const assessed = agent(saved, [{ type: 'update', id: 'hyp', changes: { confidence: 0.8 } }]);
  expect(assessed.records[1].title).toBe('User title');
  expect(
    agent(assessed, [
      { type: 'update', id: 'hyp', changes: { title: 'Agreed correction' }, overrideUser: true },
    ]).records[1].title,
  ).toBe('Agreed correction');
});

it.each(['node', 'relation', 'explanation'] as const)(
  'protects cascading deletion of a user-authored %s',
  (target) => {
    const graph = base();
    const operation: MapOperation =
      target === 'node'
        ? { type: 'update', id: 'leaf', changes: { detail: 'User evidence' } }
        : target === 'relation'
          ? { type: 'update_relation', id: 'link', changes: { rationale: 'User connection' } }
          : {
              type: 'insert_explanation',
              explanation: { id: 'answer', nodeId: 'leaf', question: 'Why?', answer: 'Because.' },
            };
    const saved = applyMapOperations(graph, [operation]);
    expect(() => agent(saved, [{ type: 'remove', id: 'hyp' }])).toThrow('protected');
    const removed = agent(saved, [{ type: 'remove', id: 'hyp', overrideUser: true }]);
    expect(removed.records.map((node) => node.id)).toEqual(['root', 'peer']);
    expect(removed.relations).toEqual([]);
    expect(removed.explanations ?? []).toEqual([]);
  },
);

it('keeps tombstones for every removed user branch member and incident attachment', () => {
  const graph = applyMapOperations(base(), [{ type: 'remove', id: 'hyp' }]);
  expect(graph.userDeleted).toMatchObject({ records: ['hyp', 'leaf'], relations: ['link'] });
  const node = base().records[1];
  expect(() => agent(graph, [{ type: 'insert', node }])).toThrow('User-deleted');
  const restored = agent(graph, [{ type: 'insert', node, overrideUser: true }]);
  expect(restored.records.some((item) => item.id === node.id)).toBe(true);
  expect(restored.userDeleted?.records).not.toContain(node.id);
});

it('supports cross-links and explanations to user-created nodes without overwriting the node', () => {
  const node = { id: 'user', parent: 'root', title: 'Question', detail: '' };
  const graph = applyMapOperations(base(), [{ type: 'insert', node }]);
  const next = agent(graph, [
    { type: 'insert_relation', relation: { id: 'user-link', source: 'user', target: 'hyp' } },
    {
      type: 'insert_explanation',
      explanation: { id: 'answer', nodeId: 'user', question: 'Why?', answer: 'Evidence.' },
    },
  ]);
  expect(next.records.find((item) => item.id === 'user')).toEqual({ ...node, userEdited: ['*'] });
  expect(next.explanations?.[0].answer).toBe('Evidence.');
  expect(() =>
    agent(next, [{ type: 'update', id: 'user', changes: { title: 'Overwrite' } }]),
  ).toThrow('protected');
  expect(() =>
    agent(next, [
      {
        type: 'insert_explanation',
        explanation: { id: 'bad', nodeId: 'missing', question: 'Why?', answer: 'Unknown.' },
      },
    ]),
  ).toThrow('unavailable');
});

it('moves branches and rejects roots, duplicate IDs and invalid endpoints', () => {
  expect(
    agent(base(), [{ type: 'move', id: 'leaf', parent: 'peer' }]).records.find(
      (node) => node.id === 'leaf',
    )?.parent,
  ).toBe('peer');
  for (const operation of [
    { type: 'move', id: 'root', parent: 'peer' },
    { type: 'remove', id: 'root' },
    { type: 'insert', node: base().records[1] },
    { type: 'insert_relation', relation: { id: 'bad', source: 'hyp', target: 'absent' } },
  ] satisfies MapOperation[])
    expect(() => agent(base(), [operation])).toThrow();
});

it('undo operations reconstruct content and links as a new revision', () => {
  const original = base();
  const changed = applyMapOperations(original, [{ type: 'remove', id: 'hyp' }]);
  const undone = applyMapOperations(changed, graphDifference(changed, original));
  expect(undone.revision).toBe(2);
  expect(
    undone.records
      .map(({ userEdited: _fields, ...node }) => node)
      .sort((a, b) => a.id.localeCompare(b.id)),
  ).toEqual([...original.records].sort((a, b) => a.id.localeCompare(b.id)));
  expect(undone.records.filter((node) => node.parent === 'root').map((node) => node.id)).toEqual([
    'hyp',
    'peer',
  ]);
  expect(undone.relations.map(({ userEdited: _fields, ...link }) => link)).toEqual(
    original.relations,
  );
});

it.each(['__proto__', 'constructor', 'prototype', '../escape'])('rejects unsafe IDs: %s', (id) => {
  expect(() =>
    parseGraphUpdate({ expectedRevision: 0, operations: [{ type: 'remove', id }] }),
  ).toThrow();
});
it.each([
  { type: 'update', id: 'hyp', changes: { userEdited: [] } },
  { type: 'update', id: 'hyp', changes: { parent: 'peer' } },
  { type: 'update', id: 'hyp', changes: { title: null } },
  { type: 'update', id: 'hyp', changes: { confidence: 2 } },
  { type: 'insert', node: { id: 'x', title: 'X', detail: '', userEdited: [] } },
  { type: 'update_explanation', id: 'x', changes: { nodeId: 'peer', answer: 'Moved' } },
  { type: 'update', id: 'hyp', changes: { sources: [{ label: 'Bad', path: '../secret' }] } },
  {
    type: 'update',
    id: 'hyp',
    changes: { sources: [{ label: 'Bad', url: 'https://user:password@example.com' }] },
  },
])('rejects invalid or authority-bearing operation %j', (operation) => {
  expect(() => parseGraphUpdate({ expectedRevision: 0, operations: [operation] })).toThrow();
});
it('rejects malformed persisted graphs', () => {
  expect(() =>
    validateGraph({ ...base(), records: [{ id: 'x', parent: 'x', title: 'Cycle', detail: '' }] }),
  ).toThrow();
});

it('protects sibling order even when an agent moves a different sibling', () => {
  const graph = applyMapOperations(base(), [
    { type: 'move', id: 'hyp', parent: 'root', after: 'peer' },
  ]);
  expect(graph.records.find((node) => node.id === 'root')?.userEdited).toContain('children');
  expect(() => agent(graph, [{ type: 'move', id: 'peer', parent: 'root', after: 'hyp' }])).toThrow(
    'protected',
  );
  expect(() =>
    agent(graph, [{ type: 'move', id: 'peer', parent: 'root', after: 'hyp', overrideUser: true }]),
  ).not.toThrow();
});

it('can undo deletion of a large branch with its links and explanations in one bounded batch', () => {
  const graph = base();
  for (let index = 0; index < 150; index++) {
    const id = `child${index}`;
    graph.records.push({ id, parent: 'hyp', title: id, detail: '' });
    graph.relations.push({ id, source: id, target: 'peer' });
    (graph.explanations ??= []).push({ id, nodeId: id, question: 'Why?', answer: 'Evidence.' });
  }
  const removed = applyMapOperations(graph, [{ type: 'remove', id: 'hyp' }]);
  const operations = parseGraphUpdate({
    expectedRevision: removed.revision,
    operations: graphDifference(removed, graph),
  }).operations;
  const restored = applyMapOperations(removed, operations);
  expect(restored.records).toHaveLength(graph.records.length);
  expect(restored.relations).toHaveLength(graph.relations.length);
  expect(restored.explanations).toHaveLength(graph.explanations?.length ?? 0);
});

const undo = (current: GraphDocument, previous: GraphDocument) =>
  applyMapOperations(current, graphDifference(current, previous, { restore: true }));

it('undoing a rename restores the agent’s authority over the field', () => {
  const edited = applyMapOperations(base(), [
    { type: 'update', id: 'hyp', changes: { title: 'Mine' } },
  ]);
  expect(edited.records[1].userEdited).toEqual(['title']);
  const restored = undo(edited, base());
  expect(restored.records[1].title).toBe('Hypothesis');
  expect(restored.records[1].userEdited).toBeUndefined();
  expect(() =>
    agent(restored, [{ type: 'update', id: 'hyp', changes: { title: 'Agent' } }]),
  ).not.toThrow();
});

it('undoing a branch deletion restores agent ownership, order, and no tombstones', () => {
  const deleted = applyMapOperations(base(), [{ type: 'remove', id: 'hyp' }]);
  expect(deleted.userDeleted?.records).toEqual(['hyp', 'leaf']);
  const restored = undo(deleted, base());
  const children = (parent: string) =>
    restored.records.filter((node) => node.parent === parent).map((node) => node.id);
  expect(children('root')).toEqual(['hyp', 'peer']);
  expect(children('hyp')).toEqual(['leaf']);
  expect(restored.records.every((node) => node.userEdited === undefined)).toBe(true);
  expect(restored.relations[0].userEdited).toBeUndefined();
  expect(restored.userDeleted?.records).toEqual([]);
  expect(() =>
    agent(restored, [{ type: 'update', id: 'hyp', changes: { detail: 'Agent' } }]),
  ).not.toThrow();
});

it('undoing an addition leaves no tombstone and redoing a deletion keeps one', () => {
  const added = applyMapOperations(base(), [
    { type: 'insert', node: { id: 'mine', parent: 'root', title: 'Mine', detail: '' } },
  ]);
  expect(undo(added, base()).userDeleted).toBeUndefined();
  const deleted = applyMapOperations(base(), [{ type: 'remove', id: 'peer' }]);
  const redone = undo(undo(deleted, base()), deleted);
  expect(redone.userDeleted?.records).toEqual(['peer']);
});

it('deleting a user-created node leaves no tombstone and never stores empty protection', () => {
  const added = applyMapOperations(base(), [
    { type: 'insert', node: { id: 'mine', parent: 'root', title: 'Mine', detail: '' } },
  ]);
  const removed = applyMapOperations(added, [{ type: 'remove', id: 'mine' }]);
  expect(removed.userDeleted).toBeUndefined();
  const moved = applyMapOperations(removed, [{ type: 'move', id: 'peer', parent: 'root' }]);
  expect(moved.records.some((node) => node.userEdited?.length === 0)).toBe(false);
});

it('rejects protection restores from agents and accepts them in parsed user updates', () => {
  expect(() =>
    agent(base(), [{ type: 'update', id: 'hyp', changes: { title: 'X' }, userEdited: [] }]),
  ).toThrow(/Only user edits/);
  expect(() => agent(base(), [{ type: 'remove', id: 'peer', tombstone: false }])).toThrow(
    /Only user edits/,
  );
  const parsed = parseGraphUpdate({
    expectedRevision: 0,
    operations: [
      { type: 'update', id: 'hyp', changes: {}, userEdited: ['title'] },
      { type: 'remove', id: 'peer', tombstone: false },
    ],
  });
  expect(parsed.operations).toHaveLength(2);
  expect(() =>
    parseGraphUpdate({
      expectedRevision: 0,
      operations: [{ type: 'remove', id: 'peer', userEdited: [] }],
    }),
  ).toThrow(/Removals cannot set protection/);
});

it('caps the serialized document size with an actionable message', () => {
  const graph = base();
  for (let index = 0; index < 150; index++)
    graph.records.push({
      id: `big${index}`,
      parent: 'root',
      title: `Big ${index}`,
      detail: 'x'.repeat(GRAPH_LIMITS.detail),
      result: 'y'.repeat(GRAPH_LIMITS.result),
    });
  expect(JSON.stringify(graph).length).toBeGreaterThan(GRAPH_MAX_BYTES);
  expect(() => validateGraph(graph)).toThrow(/exceeds 2 MB.*shorten/);
});

it('rejects self-loop relations and duplicate (source, target, kind) triples', () => {
  expect(() =>
    agent(base(), [
      {
        type: 'insert_relation',
        relation: { id: 'loop', source: 'hyp', target: 'hyp', kind: 'supports' },
      },
    ]),
  ).toThrow('Relation loop links hyp to itself.');
  expect(() =>
    agent(base(), [
      {
        type: 'insert_relation',
        relation: { id: 'other', source: 'leaf', target: 'peer', kind: 'fits' },
      },
      { type: 'update_relation', id: 'other', changes: { kind: 'supports' } },
    ]),
  ).toThrow('Relation other duplicates link (leaf → peer, supports).');
  expect(() =>
    agent(base(), [
      {
        type: 'insert_relation',
        relation: { id: 'dup', source: 'leaf', target: 'peer', kind: 'supports' },
      },
    ]),
  ).toThrow('Relation dup duplicates link (leaf → peer, supports).');
  expect(() =>
    agent(base(), [
      {
        type: 'insert_relation',
        relation: { id: 'other', source: 'leaf', target: 'peer', kind: 'fits' },
      },
    ]),
  ).not.toThrow();
});

it('rejects a changed relation that duplicates one stored after it', () => {
  const graph = agent(base(), [
    {
      type: 'insert_relation',
      relation: { id: 'other', source: 'hyp', target: 'peer', kind: 'fits' },
    },
  ]);
  // 'link' is stored before 'other', so checking it against only the links seen so far
  // would wave this through and persist two identical edges.
  expect(() =>
    agent(graph, [
      {
        type: 'update_relation',
        id: 'link',
        changes: { source: 'hyp', target: 'peer', kind: 'fits' },
      },
    ]),
  ).toThrow('Relation link duplicates link (hyp → peer, fits).');
});

it('keeps persisted relations that predate the strict checks editable and replayable', () => {
  const persisted: GraphDocument = {
    ...base(),
    relations: [
      { id: 'link', source: 'leaf', target: 'peer', kind: 'supports' },
      { id: 'dup', source: 'leaf', target: 'peer', kind: 'supports' },
      { id: 'loop', source: 'hyp', target: 'hyp' },
    ],
  };
  expect(() => validateGraph(persisted)).not.toThrow();
  const edited = agent(persisted, [{ type: 'update', id: 'peer', changes: { title: 'Edited' } }]);
  expect(edited.relations).toHaveLength(3);
  const replay: MapOperation[] = [
    {
      type: 'insert_relation',
      relation: { id: 'again', source: 'leaf', target: 'peer', kind: 'supports' },
    },
  ];
  expect(() => applyMapOperations(base(), replay, 0, 'agent')).toThrow('duplicates link');
  expect(
    applyMapOperations(base(), replay, 0, 'agent', { strictRelations: false }).relations,
  ).toHaveLength(2);
});

it('rejects tombstones for live IDs and duplicated protection fields', () => {
  expect(() => validateGraph({ ...base(), userDeleted: { records: ['hyp'] } })).toThrow(
    'Deleted ID hyp is still a live record.',
  );
  expect(() => validateGraph({ ...base(), userDeleted: { records: ['gone'] } })).not.toThrow();
  const graph = base();
  graph.records[1].userEdited = ['title', 'title'];
  expect(() => validateGraph(graph)).toThrow('Invalid protected fields.');
  expect(() =>
    parseGraphUpdate({
      expectedRevision: 0,
      operations: [{ type: 'update', id: 'hyp', changes: {}, userEdited: ['title', 'title'] }],
    }),
  ).toThrow('Invalid protected fields.');
});

it('reports an unparseable source URL with the module message instead of a TypeError', () => {
  expect(() =>
    parseGraphUpdate({
      expectedRevision: 0,
      operations: [
        { type: 'update', id: 'hyp', changes: { sources: [{ label: 'Bad', url: 'not a url' }] } },
      ],
    }),
  ).toThrow('Invalid source URL.');
});

it('distinguishes unknown IDs from removed ones and rejects moving a node after itself', () => {
  expect(() =>
    agent(base(), [{ type: 'insert', node: { id: 'x', parent: 'never', title: 'X', detail: '' } }]),
  ).toThrow('Unknown graph item never.');
  const deleted = applyMapOperations(base(), [{ type: 'remove', id: 'hyp' }]);
  expect(() =>
    agent(deleted, [{ type: 'insert', node: { id: 'x', parent: 'hyp', title: 'X', detail: '' } }]),
  ).toThrow('Graph item hyp is no longer available.');
  expect(() =>
    agent(base(), [
      { type: 'remove', id: 'hyp' },
      { type: 'update', id: 'leaf', changes: { title: 'Gone' } },
    ]),
  ).toThrow('Graph item leaf is no longer available.');
  expect(() =>
    agent(base(), [{ type: 'move', id: 'peer', parent: 'root', after: 'peer' }]),
  ).toThrow('A node cannot be placed after itself.');
});

it('does not move surviving siblings when only a sibling was removed', () => {
  const removed = applyMapOperations(base(), [{ type: 'remove', id: 'hyp' }]);
  const operations = graphDifference(base(), removed);
  expect(operations).toEqual([{ type: 'remove', id: 'hyp' }]);
});
