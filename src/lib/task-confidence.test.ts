import { describe, expect, it } from 'vitest';
import { parseConfidencePayload } from '../../electron/shared/task-confidence';
import { isConfidenceStale, restoreTaskConfidence } from './task-confidence';

describe('parseConfidencePayload', () => {
  it('accepts named scores, findings and a source', () => {
    expect(
      parseConfidencePayload({
        scores: [{ label: ' Correct ', score: 79.6, why: 'Happy path   tested.' }],
        findings: [{ kind: 'extra', text: 'Renamed helpers.', file: 'src/a.ts' }],
        source: 'review skill',
      }),
    ).toEqual({
      scores: [{ label: 'Correct', score: 80, why: 'Happy path tested.' }],
      findings: [{ kind: 'extra', text: 'Renamed helpers.', file: 'src/a.ts' }],
      source: 'review skill',
    });
  });

  it('rejects out-of-range scores, unknown kinds and missing reasons', () => {
    const score = { label: 'Confidence', score: 50, why: 'x' };
    expect(() => parseConfidencePayload({ scores: [] })).toThrow('scores must be');
    expect(() => parseConfidencePayload({ scores: [{ ...score, score: 101 }] })).toThrow(
      'from 0 to 100',
    );
    expect(() => parseConfidencePayload({ scores: [{ ...score, why: ' ' }] })).toThrow(
      'why is required',
    );
    expect(() =>
      parseConfidencePayload({ scores: [score], findings: [{ kind: 'todo', text: 'x' }] }),
    ).toThrow('kind must be');
    expect(() => parseConfidencePayload('nope')).toThrow('must be an object');
  });
});

describe('restoreTaskConfidence', () => {
  it('restores a saved rating and drops a malformed one', () => {
    const saved = {
      scores: [{ label: 'Confidence', score: 70, why: 'x' }],
      findings: [],
      publishedAt: 10,
      fingerprint: 'f1',
    };
    expect(restoreTaskConfidence(saved)).toEqual(saved);
    expect(restoreTaskConfidence({ ...saved, publishedAt: 'later' })).toBeUndefined();
    expect(restoreTaskConfidence({ ...saved, scores: [] })).toBeUndefined();
    expect(restoreTaskConfidence(null)).toBeUndefined();
  });
});

describe('isConfidenceStale', () => {
  const rating = { publishedAt: 100, fingerprint: 'a' };

  it('is stale only when a later brief saw different code', () => {
    expect(isConfidenceStale(rating, { generatedAt: 200, fingerprint: 'b' })).toBe(true);
    expect(isConfidenceStale(rating, { generatedAt: 200, fingerprint: 'a' })).toBe(false);
    expect(isConfidenceStale(rating, { generatedAt: 50, fingerprint: 'b' })).toBe(false);
  });

  it('counts as current when there is nothing to compare', () => {
    expect(isConfidenceStale(rating, undefined)).toBe(false);
    expect(isConfidenceStale({ publishedAt: 100 }, { generatedAt: 200, fingerprint: 'b' })).toBe(
      false,
    );
  });
});
