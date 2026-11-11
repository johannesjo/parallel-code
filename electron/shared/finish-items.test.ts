import { describe, expect, it } from 'vitest';
import { parseFinishItems } from './finish-items.js';

describe('parseFinishItems', () => {
  it('collapses each item to one trimmed line', () => {
    expect(
      parseFinishItems({ items: ['  Remove the\n  DEBUG_SYNC flag ', 'Update docs'] }),
    ).toEqual(['Remove the DEBUG_SYNC flag', 'Update docs']);
  });

  it('drops blank items and case-insensitive duplicates, keeping the first', () => {
    expect(parseFinishItems({ items: ['Update docs', '   ', 'update DOCS', 'Drop log'] })).toEqual([
      'Update docs',
      'Drop log',
    ]);
  });

  it('accepts an empty list, which clears the items', () => {
    expect(parseFinishItems({ items: [] })).toEqual([]);
  });

  it('rejects malformed payloads', () => {
    expect(() => parseFinishItems(null)).toThrow('{items: string[]}');
    expect(() => parseFinishItems(['a'])).toThrow('{items: string[]}');
    expect(() => parseFinishItems({ items: 'a' })).toThrow('{items: string[]}');
    expect(() => parseFinishItems({ items: [1] })).toThrow('must be a string');
  });

  it('rejects more than 8 distinct items and items over 200 characters', () => {
    const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    expect(() => parseFinishItems({ items: nine })).toThrow('At most 8');
    expect(parseFinishItems({ items: [...nine.slice(0, 8), 'A'] })).toHaveLength(8);
    expect(() => parseFinishItems({ items: ['x'.repeat(201)] })).toThrow('at most 200');
    expect(parseFinishItems({ items: ['x'.repeat(200)] })).toEqual(['x'.repeat(200)]);
  });
});
