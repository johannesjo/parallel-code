import { describe, expect, it } from 'vitest';
import { anchorIndexIn, type ScrollAnchor } from './scroll-anchor';
import type { DocumentBlock } from './markdown-blocks';

function blocks(...raws: string[]): DocumentBlock[] {
  return raws.map((raw, index) => ({
    index,
    type: 'paragraph',
    startLine: index + 1,
    endLine: index + 1,
    raw,
    html: `<p>${raw}</p>`,
  }));
}

const anchor = (index: number, raw: string, before: string | null = null): ScrollAnchor => ({
  index,
  raw,
  before,
  offset: 0,
});

describe('anchorIndexIn', () => {
  it('keeps the index when the passage did not move', () => {
    expect(anchorIndexIn(blocks('a', 'b', 'c'), anchor(1, 'b'))).toBe(1);
  });

  it('follows the passage down when an edit inserts above it', () => {
    expect(anchorIndexIn(blocks('a', 'new', 'b', 'c'), anchor(1, 'b'))).toBe(2);
  });

  it('follows the passage up when an edit removes above it', () => {
    expect(anchorIndexIn(blocks('a', 'c'), anchor(2, 'c'))).toBe(1);
  });

  it('tells identical passages apart by what sits above them', () => {
    const document = blocks('new', 'a', '---', 'b', '---', 'c');
    // The reader was on the `---` under `b`, which the insertion pushed down.
    expect(anchorIndexIn(document, anchor(3, '---', 'b'))).toBe(4);
  });

  it('takes the one below when two identical passages keep identical company', () => {
    // Both `---` sit under a `p`, so only the direction decides — and the edit
    // this exists for pushes the passage down.
    expect(anchorIndexIn(blocks('p', '---', 'p', '---'), anchor(2, '---', 'p'))).toBe(3);
  });

  it('reaches a passage that a shrunken document moved far up', () => {
    const document = blocks('a', 'b', 'c', 'kept', 'd');
    expect(anchorIndexIn(document, anchor(90, 'kept'))).toBe(3);
  });

  it('falls back to the index when the passage itself was rewritten', () => {
    expect(anchorIndexIn(blocks('a', 'rewritten', 'c'), anchor(1, 'b'))).toBe(1);
  });

  it('clamps to the last block of a document that lost its tail', () => {
    expect(anchorIndexIn(blocks('a'), anchor(4, 'e'))).toBe(0);
  });

  it('has nowhere to anchor in an empty document', () => {
    expect(anchorIndexIn([], anchor(0, 'a'))).toBeNull();
  });
});
