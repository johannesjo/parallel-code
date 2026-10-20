import { describe, expect, it } from 'vitest';
import { formatRelativeAge } from './relativeAge';

describe('formatRelativeAge', () => {
  it('rounds down to the largest whole unit', () => {
    const now = 1_000_000_000;
    expect(formatRelativeAge(now - 30_000, now)).toBe('just now');
    expect(formatRelativeAge(now - 59 * 60_000, now)).toBe('59m');
    expect(formatRelativeAge(now - 3 * 3_600_000, now)).toBe('3h');
    expect(formatRelativeAge(now - 49 * 3_600_000, now)).toBe('2d');
  });

  it('never reports a negative age for a clock that ran ahead', () => {
    expect(formatRelativeAge(2_000, 1_000)).toBe('just now');
  });
});
