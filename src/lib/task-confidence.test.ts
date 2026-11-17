import { describe, expect, it } from 'vitest';
import { parseConfidencePayload } from '../../electron/shared/task-confidence';
import { inConfidenceOrder, isConfidenceOutdated, restoreTaskConfidence } from './task-confidence';

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

  it('accepts what was asked, the behaviour changes and the key line', () => {
    const score = { label: 'Correct', score: 80, why: 'x' };
    expect(
      parseConfidencePayload({
        scores: [score],
        asked: ' Keep the return URL  through sign-in. ',
        changes: [{ now: 'You land where you were going', before: 'instead of /', tested: 'unit' }],
        keyLine: { file: 'src/auth.ts', line: 72, why: 'The only redirect guard.' },
      }),
    ).toEqual({
      scores: [score],
      findings: [],
      asked: 'Keep the return URL through sign-in.',
      changes: [{ now: 'You land where you were going', before: 'instead of /', tested: 'unit' }],
      keyLine: { file: 'src/auth.ts', line: 72, why: 'The only redirect guard.' },
    });
    expect(() => parseConfidencePayload({ scores: [score], changes: [{ before: 'x' }] })).toThrow(
      'now is required',
    );
    expect(() =>
      parseConfidencePayload({ scores: [score], keyLine: { file: 'a.ts', line: 0, why: 'x' } }),
    ).toThrow('positive whole number');
  });

  it('keeps what a score was checked against, dropping blank items', () => {
    const score = { label: 'Correct', score: 80, why: 'x' };
    expect(
      parseConfidencePayload({ scores: [{ ...score, verified: [' read  both callers ', ' '] }] })
        .scores,
    ).toEqual([{ ...score, verified: ['read both callers'] }]);
    expect(parseConfidencePayload({ scores: [{ ...score, verified: [] }] }).scores).toEqual([
      score,
    ]);
    expect(() =>
      parseConfidencePayload({ scores: [{ ...score, verified: ['a', 'b', 'c', 'd'] }] }),
    ).toThrow('at most 3 items');
    expect(() => parseConfidencePayload({ scores: [{ ...score, verified: [1] }] })).toThrow(
      'must be a string',
    );
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
    const detailed = { ...saved, asked: 'Fix it.', changes: [{ now: 'It works' }] };
    expect(restoreTaskConfidence(detailed)).toEqual(detailed);
    expect(restoreTaskConfidence({ ...saved, publishedAt: 'later' })).toBeUndefined();
    expect(restoreTaskConfidence({ ...saved, scores: [] })).toBeUndefined();
    expect(restoreTaskConfidence(null)).toBeUndefined();
  });

  it("keeps the app reviewer's mark and drops an unknown one", () => {
    const saved = { scores: [{ label: 'Confidence', score: 70, why: 'x' }], findings: [] };
    const restored = restoreTaskConfidence({
      ...saved,
      publishedAt: 10,
      origin: 'review',
      headSha: 'a1',
    });
    expect(restored).toMatchObject({ origin: 'review', headSha: 'a1' });
    expect(
      restoreTaskConfidence({ ...saved, publishedAt: 10, origin: 'agent' }),
    ).not.toHaveProperty('origin');
  });
});

describe('isConfidenceOutdated', () => {
  const rating = { publishedAt: 100, fingerprint: 'a' };

  it('is outdated only when the code read after the rating differs', () => {
    expect(isConfidenceOutdated(rating, { at: 200, fingerprint: 'b' })).toBe(true);
    expect(isConfidenceOutdated(rating, { at: 200, fingerprint: 'a' })).toBe(false);
    expect(isConfidenceOutdated(rating, { at: 50, fingerprint: 'b' })).toBe(false);
  });

  it('counts as current when there is nothing to compare', () => {
    expect(isConfidenceOutdated(rating, undefined)).toBe(false);
    expect(isConfidenceOutdated({ publishedAt: 100 }, { at: 200, fingerprint: 'b' })).toBe(false);
  });
});

describe('inConfidenceOrder', () => {
  const labels = (scores: { label: string; score: number }[]) =>
    inConfidenceOrder(scores).map((entry) => entry.label);

  it('puts correctness first, then the lowest, then the rest as published', () => {
    expect(
      labels([
        { label: 'Minimal', score: 90 },
        { label: 'Tested', score: 95 },
        { label: 'Complete', score: 70 },
        { label: 'Correct', score: 85 },
      ]),
    ).toEqual(['Correct', 'Complete', 'Minimal', 'Tested']);
  });

  it('keeps correctness first when it is also the lowest', () => {
    expect(
      labels([
        { label: 'Minimal', score: 90 },
        { label: 'correctness', score: 40 },
        { label: 'Complete', score: 80 },
      ]),
    ).toEqual(['correctness', 'Minimal', 'Complete']);
  });

  it('leads with the lowest when nothing rates correctness', () => {
    expect(
      labels([
        { label: 'Confidence', score: 80 },
        { label: 'Incorrect edge cases', score: 50 },
      ]),
    ).toEqual(['Incorrect edge cases', 'Confidence']);
  });
});
