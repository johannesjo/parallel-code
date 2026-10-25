import { describe, expect, it } from 'vitest';
import type { EvidencePackage } from '../../electron/shared/evidence';
import {
  buildReviewSummary,
  buildReworkPrompt,
  restoreReviewDismissed,
  reviewItemId,
  reviewVerdict,
  withReviewNotes,
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
    { label: 'Complete', score: 64, why: 'Misses remember-me.' },
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
    expect(summary.risks.map((risk) => risk.text)).toEqual([
      'Session cookie is cleared after the redirect.',
      'Not tried against a real OAuth provider.',
      'Remember-me path not handled.',
    ]);
    // The gap found by the rating wins over the same open item, so it keeps its file.
    expect(summary.risks[2]).toMatchObject({
      source: 'Gap found by the confidence check',
      file: 'src/auth/remember.ts',
    });
  });

  it('leaves out decisions the user kept and merges extras from both sources', () => {
    const summary = buildReviewSummary({ brief, confidence });
    expect(summary.decisions.map((entry) => entry.text)).toEqual([
      'Fallback cookie lasts 5 minutes.',
    ]);
    expect(summary.extras.map((entry) => entry.text)).toEqual([
      'Renamed parseNext to readReturnUrl.',
    ]);
  });

  it('moves dismissed risks aside', () => {
    const id = reviewItemId('risk', 'Not tried against a real OAuth provider.');
    const summary = buildReviewSummary({
      brief,
      confidence,
      dismissed: {
        [id]: { text: 'Not tried against a real OAuth provider.', reason: 'CI does it' },
      },
    });
    expect(summary.risks).toHaveLength(2);
    expect(summary.dismissed.map((risk) => risk.id)).toEqual([id]);
  });

  it('splits scores at the bar and marks a rating the code moved past', () => {
    const scores = buildReviewSummary({ brief, confidence }).scores;
    expect(scores?.low.map((entry) => entry.label)).toEqual(['Complete']);
    expect(scores?.fine.map((entry) => entry.label)).toEqual(['Correct']);
    expect(scores?.stale).toBe(true);
    expect(scores?.source).toBe('sub-agent audit');
  });

  it('groups test changes by kind and counts weakened tests not yet accepted', () => {
    const tests = buildReviewSummary({
      evidence: {
        ...evidence({
          tests: [
            { file: 'a.test.ts', kind: 'unit', title: 'keeps the URL', change: 'added' },
            { file: 'a.test.ts', kind: 'unit', title: 'redirects', change: 'changed' },
            { file: 'e2e/a.spec.ts', kind: 'e2e', title: 'billing link', change: 'removed' },
          ],
          flags: [
            { id: 'f1', category: 'test-weakened', rule: 'skip', file: 'a.test.ts', detail: '' },
            { id: 'f2', category: 'test-weakened', rule: 'skip', file: 'b.test.ts', detail: '' },
            { id: 'f3', category: 'info', rule: 'x', file: 'c.ts', detail: '' },
          ],
        }),
        acceptedFlags: { f2: 'intended' },
      },
    }).tests;
    expect(tests?.weakened).toBe(1);
    expect(tests?.groups.map((group) => group.kind)).toEqual(['unit', 'e2e']);
    expect(tests?.groups[0].added).toHaveLength(1);
    expect(tests?.groups[1].removed).toHaveLength(1);
  });

  it('has no test section when the scan saw no test changes', () => {
    expect(buildReviewSummary({ evidence: evidence() }).tests).toBeUndefined();
  });
});

describe('reviewVerdict', () => {
  it('counts open risks and failing checks', () => {
    const summary = buildReviewSummary({ brief, confidence });
    expect(reviewVerdict(summary, 0)).toBe('3 open risks');
    expect(reviewVerdict(summary, 1)).toBe('3 open risks · 1 check failing');
  });

  it('says when nothing has reviewed the task yet', () => {
    expect(reviewVerdict(buildReviewSummary({}), 0)).toBe('Not reviewed yet');
    expect(reviewVerdict(buildReviewSummary({}), 2)).toBe('2 checks failing');
  });

  it('reads as clear when nothing is open', () => {
    const summary = buildReviewSummary({
      confidence: { ...confidence, findings: [] },
    });
    expect(reviewVerdict(summary, 0)).toBe('No open risks');
  });
});

describe('prompts', () => {
  it('builds one rework prompt from the picked items and a note', () => {
    const summary = buildReviewSummary({ brief, confidence });
    const prompt = buildReworkPrompt([summary.risks[2], summary.extras[0]], 'Keep it small.');
    expect(prompt).toBe(
      [
        'Please rework this task based on my review:',
        '- Fill this gap: Remember-me path not handled. (src/auth/remember.ts)\n' +
          '- Revert this, I didn’t ask for it: Renamed parseNext to readReturnUrl.',
        'Keep it small.',
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

describe('restoreReviewDismissed', () => {
  it('keeps well-formed entries and drops the rest', () => {
    expect(restoreReviewDismissed(undefined)).toBeUndefined();
    expect(restoreReviewDismissed(['x'])).toBeUndefined();
    expect(
      restoreReviewDismissed({
        a: { text: 'Keep me', reason: 'why' },
        b: { text: '' },
        c: { text: 'No reason', reason: 4 },
        d: 'nope',
      }),
    ).toEqual({ a: { text: 'Keep me', reason: 'why' }, c: { text: 'No reason', reason: '' } });
  });
});
