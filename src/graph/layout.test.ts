import { expect, it } from 'vitest';
import { adjacentNode, positionsFor } from './layout';
import { makeFixture } from '../investigation/fixture';
import { notePresentation } from '../investigation/presentation';

it.each(['horizontal', 'vertical'] as const)(
  'keeps measured cards and branch controls apart in %s layouts',
  (orientation) => {
    const snapshot = makeFixture(100).snapshots.at(-1);
    if (!snapshot) throw new Error('Missing fixture');
    const heights = new Map(snapshot.records.map((node, index) => [node.id, index % 2 ? 130 : 70]));
    const positions = positionsFor(
      snapshot,
      (node) => notePresentation(node.kind),
      false,
      heights,
      orientation,
    );
    for (const a of snapshot.records) {
      const pa = positions.get(a.id);
      if (!pa) throw new Error('Missing node');
      for (const b of snapshot.records) {
        if (a.id === b.id) continue;
        const pb = positions.get(b.id);
        if (!pb) throw new Error('Missing node');
        const xGap =
          Math.abs(pa.x - pb.x) -
          (notePresentation(a.kind).width + notePresentation(b.kind).width) / 2;
        const yGap =
          Math.abs(pa.y - pb.y) - ((heights.get(a.id) ?? 0) + (heights.get(b.id) ?? 0)) / 2;
        expect(xGap > 0 || yGap > 0).toBe(true);
        if (b.parent === a.id)
          expect(orientation === 'horizontal' ? xGap : yGap).toBeGreaterThanOrEqual(72);
      }
    }
  },
);

it('prefers aligned neighbors while still reaching widely spaced diagonal children', () => {
  const positions = new Map([
    ['root', { x: 0, y: 0 }],
    ['diagonal', { x: 5, y: 70 }],
    ['right', { x: 100, y: 0 }],
    ['far-child', { x: -600, y: 180 }],
  ]);
  expect(adjacentNode(positions, 'root', 'ArrowRight')).toBe('right');
  expect(adjacentNode(positions, 'root', 'ArrowDown')).toBe('diagonal');
  positions.delete('diagonal');
  expect(adjacentNode(positions, 'root', 'ArrowDown')).toBe('far-child');
  expect(adjacentNode(positions, 'root', 'ArrowUp')).toBeUndefined();
  expect(adjacentNode(positions, 'missing', 'ArrowRight')).toBeUndefined();
});

it.each(['horizontal', 'vertical'] as const)(
  'reserves space after rows with peer relations in %s layout',
  (orientation) => {
    const snapshot = makeFixture().snapshots[5];
    const size = (node: (typeof snapshot.records)[number]) => notePresentation(node.kind);
    const before = positionsFor(snapshot, size, false, new Map(), orientation);
    const after = positionsFor(
      {
        ...snapshot,
        relations: [
          ...snapshot.relations,
          { id: 'peers', source: 'H1', target: 'H3', kind: 'supports' },
        ],
      },
      size,
      false,
      new Map(),
      orientation,
    );
    const axis = orientation === 'horizontal' ? 'x' : 'y';
    expect(after.get('H1')).toEqual(before.get('H1'));
    expect(after.get('H21')?.[axis]).toBe(
      (before.get('H21')?.[axis] ?? 0) + (orientation === 'horizontal' ? 96 : 48),
    );
  },
);
