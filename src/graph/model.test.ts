import { describe, expect, it } from 'vitest';
import {
  applyMapOperations,
  createMindMap,
  nodeTrail,
  restoreMindMap,
  visibleNodes,
  type MindMapDocument,
} from './model';
import { parseMindMapUpdate } from '../../electron/shared/mindmap';

const fixture = (): MindMapDocument => ({
  version: 1,
  revision: 2,
  records: [
    { id: 'root', title: 'Topic', detail: '' },
    { id: 'a', parent: 'root', title: 'A', detail: '' },
    { id: 'b', parent: 'root', title: 'B', detail: 'Notes' },
    { id: 'c', parent: 'b', title: 'C', detail: '' },
  ],
  relations: [{ id: 'link', source: 'a', target: 'c', kind: 'supports' }],
});

describe('mind map transactions', () => {
  it('preserves branch identities, notes, and cross-links when reparenting', () => {
    const before = fixture();
    const next = applyMapOperations(before, [{ type: 'move', id: 'b', parent: 'a' }]);
    expect(next.revision).toBe(3);
    expect(nodeTrail(next.records, 'c').map((node) => node.id)).toEqual(['root', 'a', 'b', 'c']);
    expect(next.records.find((node) => node.id === 'b')?.detail).toBe('Notes');
    expect(next.relations).toEqual(before.relations);
    expect(before).toEqual(fixture());
  });
  it('inserts a sibling beside its target and removes a whole branch with incident links', () => {
    const inserted = applyMapOperations(fixture(), [
      { type: 'insert', node: { id: 'new', parent: 'root', title: 'New', detail: '' }, after: 'a' },
    ]);
    expect(
      inserted.records.filter((node) => node.parent === 'root').map((node) => node.id),
    ).toEqual(['a', 'new', 'b']);
    const next = applyMapOperations(inserted, [{ type: 'remove', id: 'b' }]);
    expect(next.records.map((node) => node.id)).toEqual(['root', 'a', 'new']);
    expect(next.relations).toEqual([]);
  });
  it('rejects stale revisions, cycles, invalid text, and root removal atomically', () => {
    const before = fixture();
    expect(() => applyMapOperations(before, [], 1)).toThrow('changed');
    expect(() => applyMapOperations(before, [{ type: 'move', id: 'b', parent: 'c' }])).toThrow(
      'itself',
    );
    expect(() => applyMapOperations(before, [{ type: 'remove', id: 'root' }])).toThrow('central');
    expect(() =>
      applyMapOperations(before, [
        { type: 'update', id: 'a', changes: { title: 'Changed' } },
        { type: 'update', id: 'b', changes: { title: ' ' } },
      ]),
    ).toThrow();
    expect(before).toEqual(fixture());
  });
  it('collapses only navigation descendants, regardless of cross-links', () => {
    expect(visibleNodes(fixture().records, new Set(['b'])).map((node) => node.id)).toEqual([
      'root',
      'a',
      'b',
    ]);
  });
});

it('round-trips plain documents and rejects malformed persisted graphs', () => {
  expect(restoreMindMap(JSON.parse(JSON.stringify(fixture())))).toEqual(fixture());
  expect(restoreMindMap(createMindMap())).toBeDefined();
  const invalid: unknown[] = [
    null,
    { ...fixture(), version: 2 },
    { ...fixture(), revision: -1 },
    { ...fixture(), records: [] },
    {
      ...fixture(),
      records: [...fixture().records, { id: 'root', title: 'Duplicate', detail: '' }],
    },
    {
      ...fixture(),
      records: fixture().records.map((node) =>
        node.id === 'root' ? { ...node, parent: 'c' } : node,
      ),
    },
    {
      ...fixture(),
      records: fixture().records.map((node) =>
        node.id === 'b' ? { ...node, parent: 'missing' } : node,
      ),
    },
    { ...fixture(), relations: [{ id: 'link', source: 'root', target: 'missing' }] },
  ];
  for (const value of invalid) expect(restoreMindMap(value)).toBeUndefined();
});

it('drops the kind property when returning to Plain and keeps other updates intact', () => {
  const typed = applyMapOperations(fixture(), [
    { type: 'update', id: 'a', changes: { kind: 'goal' } },
  ]);
  expect(typed.records.find((node) => node.id === 'a')?.kind).toBe('goal');
  const plain = applyMapOperations(typed, [
    { type: 'update', id: 'a', changes: { kind: 'idea', title: 'Renamed' } },
  ]);
  const node = plain.records.find((record) => record.id === 'a');
  expect(node).toMatchObject({
    id: 'a',
    parent: 'root',
    title: 'Renamed',
    detail: '',
    userEdited: ['kind', 'title'],
  });
  expect(Object.hasOwn(node ?? {}, 'kind')).toBe(false);
  expect(
    restoreMindMap({
      ...fixture(),
      records: [...fixture().records.map((r) => ({ ...r, kind: 'idea' }))],
    }),
  ).toBeDefined();
});

it('rejects explicit undefined title or detail in agent updates', () => {
  const update = (changes: Record<string, unknown>) =>
    parseMindMapUpdate({ expectedRevision: 2, operations: [{ type: 'update', id: 'a', changes }] });
  expect(() => update({ title: undefined })).toThrow();
  expect(() => update({ detail: undefined })).toThrow();
  expect(() => update({ kind: undefined })).toThrow();
  expect(update({ title: 'Ok' }).operations).toEqual([
    { type: 'update', id: 'a', changes: { title: 'Ok' } },
  ]);
});
