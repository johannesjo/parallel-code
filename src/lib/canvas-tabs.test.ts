import { describe, expect, it } from 'vitest';
import { canvasTabKey, isMarkdownPath, tabFromKey, withTab, withoutTab } from './canvas-tabs';
import type { CanvasTab } from '../store/types';

const md = (path: string): CanvasTab => ({ kind: 'markdown', path });
const a = md('a.md');
const b = md('b.md');
const c = md('c.md');

describe('canvas tabs', () => {
  it('recognises Markdown paths by extension only', () => {
    expect(['notes.md', 'docs/Plan.MD', 'a.markdown'].map(isMarkdownPath)).toEqual([
      true,
      true,
      true,
    ]);
    expect(['readme.md.bak', 'md', 'notes.txt'].map(isMarkdownPath)).toEqual([false, false, false]);
  });

  it('keys a mind map without replacing reasoning or document tabs', () => {
    expect(tabFromKey('mindmap')).toEqual({ kind: 'mindmap' });
    const tabs: CanvasTab[] = [a, { kind: 'reasoning' }, { kind: 'mindmap' }];
    expect(withTab(tabs, { kind: 'mindmap' })).toEqual(tabs);
    expect(withoutTab(tabs, 'mindmap', 'mindmap')).toEqual({
      tabs: [a, { kind: 'reasoning' }],
      active: 'reasoning',
    });
  });
  it('keys one reasoning panel without a document path', () => {
    expect(tabFromKey('reasoning')).toEqual({ kind: 'reasoning' });
    expect(canvasTabKey({ kind: 'reasoning' })).toBe('reasoning');
    expect(withTab([{ kind: 'reasoning' }], { kind: 'reasoning' })).toEqual([
      { kind: 'reasoning' },
    ]);
  });
  it('keys round-trip, colons in the path included', () => {
    const tab = md('docs/a:b.md');
    expect(tabFromKey(canvasTabKey(tab))).toEqual(tab);
    expect(tabFromKey('browser:preview')).toEqual({ kind: 'browser', path: 'preview' });
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
