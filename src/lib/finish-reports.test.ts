import { describe, expect, it } from 'vitest';
import { finishReports, finishReportsTitle } from './finish-reports';
import type { TaskConfidence } from './task-confidence';

const confidence = (fingerprint: string): TaskConfidence => ({
  scores: [
    { label: 'Correct', score: 82, why: '' },
    { label: 'Complete', score: 90, why: '' },
  ],
  findings: [],
  publishedAt: 100,
  fingerprint,
});

describe('finishReports', () => {
  it('lists a review and screens taken at the current commit', () => {
    const reports = finishReports({
      confidence: confidence('a'),
      codeFingerprint: { fingerprint: 'a', at: 200 },
      screens: { headSha: 'h1', count: 3, capturedAt: 50 },
      headSha: 'h1',
    });
    expect(reports).toEqual([
      { kind: 'review', label: 'Review (lowest score 82%)', outdated: false },
      { kind: 'screens', label: 'Before & after (3 screens)', outdated: false },
    ]);
  });

  it('marks a review of older code and screens of an older commit outdated', () => {
    const reports = finishReports({
      confidence: confidence('a'),
      codeFingerprint: { fingerprint: 'b', at: 200 },
      screens: { headSha: 'h1', count: 3, capturedAt: 50 },
      headSha: 'h2',
    });
    expect(reports.map((r) => r.outdated)).toEqual([true, true]);
  });

  it('marks screens of code that changed since outdated, even without a commit', () => {
    const screens = { headSha: 'h1', count: 2, capturedAt: 100, fingerprint: 'a' };
    const changed = { fingerprint: 'b', at: 200 };
    expect(finishReports({ screens, codeFingerprint: changed, headSha: 'h1' })[0]?.outdated).toBe(
      true,
    );
    const same = { fingerprint: 'a', at: 200 };
    expect(finishReports({ screens, codeFingerprint: same, headSha: 'h1' })[0]?.outdated).toBe(
      false,
    );
  });

  it('lists a tour between the review and the screens, outdated once the diff changes', () => {
    const tour = { generatedAt: 100, fingerprint: 'a', stops: 1 };
    const reports = finishReports({
      confidence: confidence('a'),
      tour,
      screens: { headSha: 'h1', count: 1, capturedAt: 50 },
      codeFingerprint: { fingerprint: 'a', at: 200 },
    });
    expect(reports.map((r) => r.kind)).toEqual(['review', 'tour', 'screens']);
    expect(reports[1]).toEqual({ kind: 'tour', label: 'Tour (1 stop)', outdated: false });
    const changed = finishReports({ tour, codeFingerprint: { fingerprint: 'b', at: 200 } });
    expect(changed[0]?.outdated).toBe(true);
    // A code read from before the tour says nothing about it.
    const earlier = finishReports({ tour, codeFingerprint: { fingerprint: 'b', at: 50 } });
    expect(earlier[0]?.outdated).toBe(false);
  });

  it('does not count a tour without stops', () => {
    expect(finishReports({ tour: { generatedAt: 1, fingerprint: 'a', stops: 0 } })).toEqual([]);
  });

  it('does not count a capture that found nothing to show', () => {
    expect(
      finishReports({ screens: { headSha: 'h1', count: 0, capturedAt: 50 }, headSha: 'h1' }),
    ).toEqual([]);
  });

  it('keeps screens while the current commit is unknown', () => {
    expect(finishReports({ screens: { headSha: 'h1', count: 1, capturedAt: 50 } })).toEqual([
      { kind: 'screens', label: 'Before & after (1 screen)', outdated: false },
    ]);
  });
});

describe('finishReportsTitle', () => {
  it('appends the current reports to the button tooltip', () => {
    expect(
      finishReportsTitle('Finish', [{ kind: 'review', label: 'Review', outdated: false }]),
    ).toBe('Finish\nCurrent for the latest commit:\n· Review');
    expect(finishReportsTitle('Finish', [])).toBe('Finish');
  });

  it('lists outdated reports apart from the current ones', () => {
    expect(
      finishReportsTitle('Finish', [
        { kind: 'review', label: 'Review', outdated: true },
        { kind: 'tour', label: 'Tour (2 stops)', outdated: false },
      ]),
    ).toBe(
      'Finish\nCurrent for the latest commit:\n· Tour (2 stops)\n' +
        'Out of date, the code changed since:\n· Review',
    );
  });

  it('names the reports still being generated', () => {
    expect(finishReportsTitle('Finish', [], ['Review', 'Before & after'])).toBe(
      'Finish\nGenerating: Review, Before & after',
    );
  });
});
