import { describe, expect, it } from 'vitest';
import { canvasTabKey, tabFromKey, withTab, withoutTab } from './canvas-tabs';
import type { CanvasTab } from '../store/types';

const md = (path: string): CanvasTab => ({ kind: 'markdown', path });
const a = md('a.md');
const b = md('b.md');
const c = md('c.md');

describe('canvas tabs', () => {
  it('keys round-trip, colons in the path included', () => {
    const tab = md('docs/a:b.md');
    expect(tabFromKey(canvasTabKey(tab))).toEqual(tab);
    expect(tabFromKey('browser:https://x')).toBeNull();
    expect(tabFromKey('nonsense')).toBeNull();
  });

  it('adds a tab once, at the end', () => {
    expect(withTab([a], b)).toEqual([a, b]);
    expect(withTab([a, b], md('a.md'))).toEqual([a, b]);
  });

  it('closing the front tab moves to the left neighbour, else the new first', () => {
    expect(withoutTab([a, b, c], canvasTabKey(b), canvasTabKey(b))).toEqual({
      tabs: [a, c],
      active: canvasTabKey(a),
    });
    expect(withoutTab([a, b], canvasTabKey(a), canvasTabKey(a))).toEqual({
      tabs: [b],
      active: canvasTabKey(b),
    });
  });

  it('closing another tab keeps the front one, and the last close empties both', () => {
    expect(withoutTab([a, b], canvasTabKey(b), canvasTabKey(a))).toEqual({
      tabs: [b],
      active: canvasTabKey(b),
    });
    expect(withoutTab([a], canvasTabKey(a), canvasTabKey(a))).toEqual({
      tabs: [],
      active: undefined,
    });
    expect(withoutTab([a], canvasTabKey(a), 'markdown:zzz.md')).toEqual({
      tabs: [a],
      active: canvasTabKey(a),
    });
  });
});
