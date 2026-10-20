import { describe, expect, it } from 'vitest';
import { countLabel } from './plural';

describe('countLabel', () => {
  it('uses the singular only for exactly one', () => {
    expect(countLabel(1, 'reaction')).toBe('1 reaction');
    expect(countLabel(0, 'reaction')).toBe('0 reactions');
    expect(countLabel(26, 'item')).toBe('26 items');
  });
});
