import { describe, expect, it } from 'vitest';
import { makeFixture } from './fixture';
import { positionsFor } from './layout';
import { notePresentation } from './presentation';

describe('investigation navigation layout', () => {
  it('uses only discovered nodes and retains hypothesis order through revisions', () => {
    const history = makeFixture();
    expect([...positionsFor(history.snapshots[0]).keys()]).toEqual(['G1', 'BUG']);
    for (const snapshot of history.snapshots.slice(3)) {
      const positions = positionsFor(snapshot);
      expect(positions.get('G1')).toEqual({ x: 0, y: 0 });
      expect(positions.get('H1')?.x).toBeLessThan(positions.get('H2')?.x ?? 0);
      expect(positions.get('H2')?.x).toBeLessThan(positions.get('H3')?.x ?? 0);
      for (const record of snapshot.records.filter((r) => r.parent)) {
        expect(positions.get(record.id)?.y).toBeGreaterThan(
          positions.get(record.parent ?? '')?.y ?? 0,
        );
      }
    }
  });

  it.each([false, true])('keeps 100 note bounds apart (compact: %s)', (compact) => {
    const snapshot = makeFixture(100).snapshots.at(-1);
    if (!snapshot) throw new Error('Missing fixture');
    const positions = positionsFor(snapshot, compact);
    expect(positions.size).toBe(100);
    expect(positionsFor(structuredClone(snapshot), compact)).toEqual(positions);
    for (const a of snapshot.records) {
      for (const b of snapshot.records) {
        if (a.id === b.id) continue;
        const pa = positions.get(a.id),
          pb = positions.get(b.id);
        if (!pa || !pb) throw new Error('Missing position');
        const horizontalGap =
          Math.abs(pa.x - pb.x) -
          (notePresentation(a.kind, compact).width + notePresentation(b.kind, compact).width) / 2;
        const verticalGap =
          Math.abs(pa.y - pb.y) -
          (notePresentation(a.kind, compact).height + notePresentation(b.kind, compact).height) / 2;
        expect(horizontalGap > 0 || verticalGap > 0).toBe(true);
      }
    }
  });
});

it('fits three compact hypotheses across a narrow side panel', () => {
  const snapshot = makeFixture().snapshots[3];
  const compact = positionsFor(snapshot, true);
  const width = notePresentation('hypothesis', true).width;
  const span = (compact.get('H3')?.x ?? 0) - (compact.get('H1')?.x ?? 0) + width;
  expect(span).toBeLessThanOrEqual(368);
  expect(width).toBeLessThanOrEqual(112);
});

it.each([false, true])('spaces rows around measured card heights (compact: %s)', (compact) => {
  const snapshot = makeFixture().snapshots[5];
  const heights = new Map(snapshot.records.map((record, i) => [record.id, i % 2 ? 120 : 60]));
  const positions = positionsFor(snapshot, compact, heights);
  for (const record of snapshot.records) {
    if (!record.parent) continue;
    const child = positions.get(record.id);
    const parent = positions.get(record.parent);
    if (!child || !parent) throw new Error('Missing position');
    const gap =
      child.y -
      (heights.get(record.id) ?? 0) / 2 -
      parent.y -
      (heights.get(record.parent) ?? 0) / 2;
    expect(gap).toBeGreaterThanOrEqual(40);
  }
});
