import { describe, expect, it } from 'vitest';
import type { EvidencePackage } from '../../electron/shared/evidence';
import {
  buildReviewSummary,
  buildReworkPrompt,
  capReviewDismissals,
  isRiskDismissed,
  restoreReviewDismissed,
  reviewItemId,
  reviewVerdict,
  withReviewNotes,
  type ReviewDismissal,
} from './review-summary';
import type { TaskBriefRecord } from './task-brief';
import type { TaskConfidence } from './task-confidence';

const brief: TaskBriefRecord = {
  brief: {
    goal: 'Send people back to where they came from after sign-in.',
    headline: 'Check remember-me',
    unbacked: [{ text: 'Session cookie is cleared after the redirect.' }],
    changed: [{ text: 'Sign-in lands on the requested page.', file: 'src/auth/redirect.ts' }],
    extra: [{ text: 'Renamed parseNext to readReturnUrl.' }],
    open: [{ text: 'Remember-me path not handled.' }],
    decided: [{ text: 'Fallback cookie lasts 5 minutes.' }, { text: 'Kept the old route.' }],
  },
  generatedAt: 2_000,
  fingerprint: 'new',
  turns: [],
  decisions: { 'Kept the old route.': 'kept' },
};

const confidence: TaskConfidence = {
  scores: [
    { label: 'Correct', score: 88, why: 'Happy path tested.' },
    { label: 'Complete', score: 50, why: 'Misses remember-me.' },
  ],
  findings: [
    { kind: 'risk', text: 'Not tried against a real OAuth provider.' },
    { kind: 'gap', text: 'Remember-me path not handled.', file: 'src/auth/remember.ts' },
    { kind: 'extra', text: 'Renamed parseNext to readReturnUrl.' },
  ],
  source: 'sub-agent audit',
  publishedAt: 1_000,
  fingerprint: 'old',
};

function evidence(overrides: Partial<EvidencePackage['scan']> = {}): EvidencePackage {
  return {
    id: 'pkg',
    createdAt: '2026-10-25T00:00:00Z',
    trigger: 'auto',
    assembling: false,
    scan: {
      headSha: 'a',
      baseSha: 'b',
      dirty: false,
      files: [],
      flags: [],
      tests: [],
      coveringTests: [],
      sourceWithoutTests: [],
      ...overrides,
    },
    checks: [],
    skipped: [],
    acceptedFlags: {},
    dismissedFindings: [],
  };
}

describe('buildReviewSummary', () => {
  it('collects risks from unbacked claims, rating findings and open items, without repeats', () => {
    const summary = buildReviewSummary({ brief, confidence });
    expect(summary.goal).toBe(brief.brief.goal);
    expect(summary.risks.map((risk) => [risk.text, risk.urgent])).toEqual([
      ['Session cookie is cleared after the redirect.', true],
      ['Not tried against a real OAuth provider.', false],
      ['Remember-me path not handled.', false],
    ]);
    // The gap found by the rating wins over the same open item, so it keeps its file.
    expect(summary.risks[2]).toMatchObject({
      source: 'Gap found by the confidence check',
      file: 'src/auth/remember.ts',
    });
    expect(summary.openRisks).toBe(3);
  });

  it('keeps handled decisions with their state and merges extras from both sources', () => {
    const summary = buildReviewSummary({ brief, confidence });
    expect(summary.decisions.map((entry) => [entry.text, entry.state])).toEqual([
      ['Fallback cookie lasts 5 minutes.', undefined],
      ['Kept the old route.', 'kept'],
    ]);
    expect(summary.extras.map((entry) => entry.text)).toEqual([
      'Renamed parseNext to readReturnUrl.',
    ]);
  });

  it('marks dismissed risks in place and leaves them out of the count', () => {
    const id = reviewItemId('risk', 'Not tried against a real OAuth provider.');
    const summary = buildReviewSummary({
      brief,
      confidence,
      dismissed: {
        [id]: { text: 'Not tried against a real OAuth provider.', reason: 'CI does it' },
      },
    });
    expect(summary.risks.map((risk) => risk.dismissed)).toEqual([false, true, false]);
    expect(summary.openRisks).toBe(2);
  });

  it('splits scores at the shared bar and judges staleness by the newest code read', () => {
    const scores = buildReviewSummary({ brief, confidence }).scores;
    expect(scores?.low.map((entry) => entry.label)).toEqual(['Complete']);
    expect(scores?.fine.map((entry) => entry.label)).toEqual(['Correct']);
    expect(scores?.stale).toBe(true);
    expect(scores?.source).toBe('sub-agent audit');
    // A fresh code read that matches the rating wins over an older brief.
    const current = buildReviewSummary({
      brief,
      confidence,
      codeFingerprint: { fingerprint: 'old', at: 3_000 },
    }).scores;
    expect(current?.stale).toBe(false);
    const moved = buildReviewSummary({
      brief: { ...brief, fingerprint: 'old' },
      confidence,
      codeFingerprint: { fingerprint: 'newer', at: 3_000 },
    }).scores;
    expect(moved?.stale).toBe(true);
  });

  it('groups test changes by kind and says when the scan is of an older commit', () => {
    const scanned = evidence({
      tests: [
        { file: 'a.test.ts', kind: 'unit', title: 'keeps the URL', change: 'added' },
        { file: 'a.test.ts', kind: 'unit', title: 'redirects', change: 'changed' },
        { file: 'e2e/a.spec.ts', kind: 'e2e', title: 'billing link', change: 'removed' },
      ],
    });
    const tests = buildReviewSummary({ evidence: scanned, headSha: 'a' }).tests;
    expect(tests?.groups.map((group) => group.kind)).toEqual(['unit', 'e2e']);
    expect(tests?.groups[0].added).toHaveLength(1);
    expect(tests?.groups[1].removed).toHaveLength(1);
    expect(tests?.outdated).toBe(false);
    expect(buildReviewSummary({ evidence: scanned, headSha: 'later' }).tests?.outdated).toBe(true);
  });

  it('has no test section when the scan saw no test changes', () => {
    expect(buildReviewSummary({ evidence: evidence() }).tests).toBeUndefined();
  });

  it('gives items that differ only in case or spacing one id', () => {
    expect(reviewItemId('risk', '  No  real\nprovider. ')).toBe(
      reviewItemId('risk', 'no real provider.'),
    );
    const twice = buildReviewSummary({
      brief: {
        ...brief,
        brief: { ...brief.brief, decided: [{ text: 'Used X.' }, { text: 'used  x.' }] },
      },
    });
    expect(twice.decisions).toHaveLength(1);
  });
});

describe('reviewVerdict', () => {
  it('counts open risks and leads with a failed verify', () => {
    const summary = buildReviewSummary({ brief, confidence });
    expect(reviewVerdict(summary, false)).toBe('3 open risks');
    expect(reviewVerdict(summary, true)).toBe('Verify failed · 3 open risks');
  });

  it('says when nothing has reviewed the task yet', () => {
    expect(reviewVerdict(buildReviewSummary({}), false)).toBe('Not reviewed yet');
    expect(reviewVerdict(buildReviewSummary({}), true)).toBe('Verify failed');
  });

  it('reads as clear when nothing is open', () => {
    const summary = buildReviewSummary({ confidence: { ...confidence, findings: [] } });
    expect(reviewVerdict(summary, false)).toBe('No open risks');
    expect(reviewVerdict(summary, true)).toBe('Verify failed · no open risks');
  });
});

describe('prompts', () => {
  it('builds one rework prompt from the picked items', () => {
    const summary = buildReviewSummary({ brief, confidence });
    expect(buildReworkPrompt([summary.risks[2], summary.extras[0]])).toBe(
      [
        'Please rework this task based on my review:',
        '- Fill this gap: Remember-me path not handled. (src/auth/remember.ts)\n' +
          '- Revert this, I didn’t ask for it: Renamed parseNext to readReturnUrl.',
      ].join('\n\n'),
    );
  });

  it('tells the next rating what the user set aside', () => {
    expect(withReviewNotes('Rate it.', [])).toBe('Rate it.');
    expect(
      withReviewNotes('Rate it.', [{ text: 'No real provider.', reason: 'CI covers it' }]),
    ).toBe(
      'Rate it.\n\nI already reviewed these and decided they need no work, so leave them out unless the code changed them:\n\n- No real provider. (CI covers it)',
    );
  });
});

describe('dismissal records', () => {
  const many = (count: number): Record<string, ReviewDismissal> =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`risk:${i}`, { text: `Risk ${i}`, reason: '' }]),
    );

  it('keeps well-formed entries and drops the rest', () => {
    expect(restoreReviewDismissed(undefined)).toBeUndefined();
    expect(restoreReviewDismissed(['x'])).toBeUndefined();
    expect(
      restoreReviewDismissed({
        'risk:a': { text: 'Keep me', reason: 'why' },
        'risk:b': { text: '' },
        'risk:c': { text: 'No reason', reason: 4 },
        'risk:d': 'nope',
        'decision:e': { text: 'Wrong kind', reason: '' },
        [`risk:${'x'.repeat(400)}`]: { text: 'Too long an id', reason: '' },
      }),
    ).toEqual({
      'risk:a': { text: 'Keep me', reason: 'why' },
      'risk:c': { text: 'No reason', reason: '' },
    });
  });

  it('caps to the newest entries, on write and on restore', () => {
    expect(Object.keys(capReviewDismissals(many(52)))).toEqual(Object.keys(many(52)).slice(2));
    const restored = restoreReviewDismissed(many(55));
    expect(Object.keys(restored ?? {})).toHaveLength(50);
    expect(restored?.['risk:54']).toBeDefined();
    expect(restored?.['risk:0']).toBeUndefined();
    expect(
      restoreReviewDismissed({ 'risk:a': { text: 'x'.repeat(500), reason: 'y'.repeat(500) } })?.[
        'risk:a'
      ],
    ).toEqual({ text: 'x'.repeat(240), reason: 'y'.repeat(300) });
  });

  it('tells whether a brief item was set aside', () => {
    const dismissed = { [reviewItemId('risk', 'No real provider.')]: { text: 'x', reason: '' } };
    expect(isRiskDismissed(dismissed, 'No real provider.')).toBe(true);
    expect(isRiskDismissed(dismissed, 'Something else.')).toBe(false);
    expect(isRiskDismissed(undefined, 'No real provider.')).toBe(false);
  });
});
