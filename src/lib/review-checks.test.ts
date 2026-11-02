import { describe, expect, it } from 'vitest';
import { restoreReviewChecks } from './review-checks';

describe('restoreReviewChecks', () => {
  it('keeps valid ids once and tells "not picked yet" apart from "none"', () => {
    expect(restoreReviewChecks(['verify', 'unit', 'verify', 7, 'no spaces'])).toEqual([
      'verify',
      'unit',
    ]);
    expect(restoreReviewChecks([])).toEqual([]);
    expect(restoreReviewChecks(undefined)).toBeUndefined();
    expect(restoreReviewChecks('verify')).toBeUndefined();
  });
});
