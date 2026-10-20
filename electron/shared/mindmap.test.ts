import { describe, expect, it } from 'vitest';
import {
  parseMindMapUpdate,
  applyMapOperations,
  createMindMap,
  restoreMindMap,
  mapNodeKinds,
} from './mindmap.js';

it.each(mapNodeKinds)(
  'round-trips the %s node type through agent updates and saved maps',
  (kind) => {
    const map = createMindMap();
    const root = map.records[0].id;
    expect(restoreMindMap(map)?.records[0].kind).toBeUndefined();
    const update = parseMindMapUpdate({
      expectedRevision: 0,
      operations: [
        {
          type: 'insert',
          node: { id: 'typed', parent: root, title: 'Typed node', detail: 'Notes', kind },
        },
        { type: 'update', id: root, changes: { kind } },
      ],
    });
    const next = applyMapOperations(map, update.operations, update.expectedRevision);
    // Plain is the absent default: 'idea' is accepted as input but never stored.
    const stored = kind === 'idea' ? undefined : kind;
    expect(
      restoreMindMap(JSON.parse(JSON.stringify(next)))?.records.map((node) => node.kind),
    ).toEqual([stored, stored]);
    expect(map.records[0].kind).toBeUndefined();
    const plain = applyMapOperations(next, [
      { type: 'update', id: root, changes: { kind: 'idea' } },
    ]);
    expect(plain.records[0].kind).toBeUndefined();
    expect('kind' in plain.records[0]).toBe(false);
  },
);

it.each(['unknown', 123, {}])(
  'rejects an invalid node type %j at persistence and MCP boundaries',
  (kind) => {
    const map = createMindMap();
    expect(restoreMindMap({ ...map, records: [{ ...map.records[0], kind }] })).toBeUndefined();
    for (const operation of [
      {
        type: 'insert',
        node: { id: 'new', parent: map.records[0].id, title: 'New', detail: '', kind },
      },
      { type: 'update', id: map.records[0].id, changes: { kind } },
    ])
      expect(() => parseMindMapUpdate({ expectedRevision: 0, operations: [operation] })).toThrow();
  },
);

it.each(['__proto__', 'constructor', 'prototype'])(
  'rejects the prototype key %s as a node ID at persistence and MCP boundaries',
  (id) => {
    const map = createMindMap();
    const root = map.records[0].id;
    expect(
      restoreMindMap({
        ...map,
        records: [...map.records, { id, parent: root, title: 'X', detail: '' }],
      }),
    ).toBeUndefined();
    expect(() =>
      parseMindMapUpdate({
        expectedRevision: 0,
        operations: [{ type: 'insert', node: { id, parent: root, title: 'X', detail: '' } }],
      }),
    ).toThrow('Invalid graph ID');
  },
);

it('restores a saved map whose relations predate the duplicate and self-loop checks', () => {
  const map = createMindMap();
  const root = map.records[0].id;
  const saved = {
    ...map,
    records: [...map.records, { id: 'child', parent: root, title: 'Child', detail: '' }],
    relations: [
      { id: 'a', source: 'child', target: root, kind: 'related' },
      { id: 'b', source: 'child', target: root, kind: 'related' },
    ],
  };
  expect(restoreMindMap(saved)).toEqual(saved);
});

describe('MCP map transactions', () => {
  it.each([
    null,
    {},
    { expectedRevision: -1, operations: [] },
    { expectedRevision: 0, operations: [{ type: 'delete-typo', id: 'child' }] },
    {
      expectedRevision: 0,
      operations: [{ type: 'update', id: 'child', changes: { parent: 'other' } }],
    },
    {
      expectedRevision: 0,
      operations: [
        {
          type: 'insert',
          node: { id: 'a', parent: 'root', title: 'A', detail: '', userEdited: [] },
        },
      ],
    },
    { expectedRevision: 0, operations: [{ type: 'remove', id: 'a', parent: 'root' }] },
  ])('rejects malformed or overreaching tool input', (input) => {
    expect(() => parseMindMapUpdate(input)).toThrow();
  });
  it('applies a batch atomically and rejects a stale agent revision', () => {
    const map = createMindMap();
    const root = map.records[0].id;
    const update = parseMindMapUpdate({
      expectedRevision: 0,
      operations: [
        { type: 'insert', node: { id: 'a', parent: root, title: 'A', detail: '' } },
        { type: 'insert', node: { id: 'b', parent: root, title: 'B', detail: '' } },
        { type: 'move', id: 'b', parent: 'a' },
      ],
    });
    const next = applyMapOperations(map, update.operations, update.expectedRevision);
    expect(next.revision).toBe(1);
    expect(next.records[2].parent).toBe('a');
    expect(() => applyMapOperations(next, update.operations, 0)).toThrow('Read it again');
    expect(() =>
      applyMapOperations(
        next,
        [
          { type: 'update', id: 'a', changes: { title: 'Changed' } },
          { type: 'remove', id: root },
        ],
        1,
      ),
    ).toThrow();
    expect(next.records[1].title).toBe('A');
    expect(map.records).toHaveLength(1);
  });
});
