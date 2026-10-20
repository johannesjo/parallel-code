import { describe, expect, it } from 'vitest';
import { applyBlockWrite, minimalBlockWrite } from './canvas-blocks';

describe('applyBlockWrite', () => {
  it('replaces only the requested source range', () => {
    expect(
      applyBlockWrite('before old after', {
        startOffset: 7,
        endOffset: 10,
        replacement: 'new',
      }),
    ).toBe('before new after');
  });

  it('preserves untouched mixed and lone-CR line endings', () => {
    const mixed = 'one\r\ntwo\nthree\rfour\r\n';
    const write = minimalBlockWrite(mixed, 'one\nTWO\nthree\nfour\n');
    expect(applyBlockWrite(mixed, write)).toBe('one\r\nTWO\nthree\rfour\r\n');
  });
});
