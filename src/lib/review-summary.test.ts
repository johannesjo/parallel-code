import { describe, expect, it } from 'vitest';
import {
  buildReviewSummary,
  buildReworkPrompt,
  capReviewDismissals,
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
    now: 'Redirect works; remember-me next.',
  },
  generatedAt: 2_000,
  fingerprint: 'new',
};

const confidence: TaskConfidence = {
  scores: [
    { label: 'Correct', score: 88, why: 'Happy path tested.' },
    { label: 'Complete', score: 50, why: 'Misses remember-me.' },
  ],
  findings: [
    { kind: 'risk', text: 'Not tried against a real OAuth provider.' },
    {
      kind: 'gap',
      text: 'Remember-me path not handled.',
      file: 'src/auth/remember.ts',
      axis: 'Complete',
    },
    { kind: 'extra', text: 'Renamed parseNext to readReturnUrl.' },
  ],
  source: 'sub-agent audit',
  publishedAt: 1_000,
  fingerprint: 'old',
};

describe('buildReviewSummary', () => {
  it("collects risks and gaps from the rating, with the brief's goal", () => {
    const summary = buildReviewSummary({ brief, confidence });
    expect(summary.goal).toBe(brief.brief.goal);
    expect(summary.risks.map((risk) => risk.text)).toEqual([
      'Not tried against a real OAuth provider.',
      'Remember-me path not handled.',
    ]);
    expect(summary.risks[1]).toMatchObject({
      source: 'Gap found by the confidence check',
      file: 'src/auth/remember.ts',
    });
    expect(summary.openRisks).toBe(2);
  });

  it('takes what was asked, the changes and the key line from the reviewer, without a brief', () => {
    const reviewed: TaskConfidence = {
      ...confidence,
      asked: 'Keep ?next= through sign-in.',
      changes: [{ now: 'You land where you were going', before: 'instead of /' }],
      keyLine: { file: 'src/auth.ts', line: 72, why: 'The only redirect guard.' },
    };
    const summary = buildReviewSummary({ confidence: reviewed });
    expect(summary).toMatchObject({
      goal: 'Keep ?next= through sign-in.',
      changes: reviewed.changes,
      keyLine: reviewed.keyLine,
    });
    // The reviewer read every prompt; a brief's reading of the ask comes second.
    expect(buildReviewSummary({ brief, confidence: reviewed }).goal).toBe(reviewed.asked);
  });

  it('lists a doubt the rater did not confirm as a risk to check, not one to fix', () => {
    const summary = buildReviewSummary({
      confidence: {
        ...confidence,
        findings: [{ kind: 'unverified', text: 'Retry only runs on a real network.' }],
      },
    });
    expect(summary.risks).toEqual([
      expect.objectContaining({
        text: 'Retry only runs on a real network.',
        unconfirmed: true,
        source: 'Not confirmed by the confidence check',
        ask: 'Check whether this holds and fix it only if it does: Retry only runs on a real network.',
      }),
    ]);
    expect(summary.openRisks).toBe(1);
  });

  it('takes extras from the rating', () => {
    const summary = buildReviewSummary({ brief, confidence });
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
    expect(summary.risks.map((risk) => risk.dismissed)).toEqual([true, false]);
    expect(summary.openRisks).toBe(1);
  });

  it('leads with the weakest score and judges staleness by the newest code read', () => {
    const summary = buildReviewSummary({ brief, confidence });
    const scores = summary.scores;
    expect(scores?.all.map((entry) => entry.label)).toEqual(['Correct', 'Complete']);
    expect(scores?.weakest?.label).toBe('Complete');
    expect(scores?.low).toBe(true);
    // A gap names the score it lowers.
    expect(summary.risks.find((risk) => risk.file)?.axis).toBe('Complete');
    const fine = buildReviewSummary({
      confidence: { ...confidence, scores: [{ label: 'Correct', score: 75, why: 'x' }] },
    }).scores;
    expect([fine?.weakest?.score, fine?.low]).toEqual([75, false]);
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

  it('gives items that differ only in case or spacing one id', () => {
    expect(reviewItemId('risk', '  No  real\nprovider. ')).toBe(
      reviewItemId('risk', 'no real provider.'),
    );
    const twice = buildReviewSummary({
      confidence: {
        ...confidence,
        findings: [
          { kind: 'extra', text: 'Used X.' },
          { kind: 'extra', text: 'used  x.' },
        ],
      },
    });
    expect(twice.extras).toHaveLength(1);
  });
});

describe('reviewVerdict', () => {
  it('gives the weakest score and the open count', () => {
    const summary = buildReviewSummary({ brief, confidence });
    expect(reviewVerdict(summary)).toBe('50% · 2 open');
  });

  it('says when nothing has reviewed the task yet', () => {
    expect(reviewVerdict(buildReviewSummary({}))).toBe('Not reviewed yet');
  });

  it('reads as clear when nothing is open', () => {
    const summary = buildReviewSummary({ confidence: { ...confidence, findings: [] } });
    expect(reviewVerdict(summary)).toBe('50% · nothing open');
    const unscored = buildReviewSummary({
      confidence: { ...confidence, scores: [], findings: [] },
    });
    expect(reviewVerdict(unscored)).toBe('No open risks');
  });

  it('does not read as clear before anything rated the task', () => {
    expect(reviewVerdict(buildReviewSummary({ brief }))).toBe('Not rated yet');
    const unscored = { ...confidence, scores: [] };
    expect(reviewVerdict(buildReviewSummary({ brief, confidence: unscored }))).toBe('2 open risks');
  });
});

describe('prompts', () => {
  it('builds one rework prompt from the picked items', () => {
    const summary = buildReviewSummary({ brief, confidence });
    const prompt = buildReworkPrompt([summary.risks[1], summary.extras[0]]);
    expect(prompt).toMatch(
      /^Please rework this task based on my review:\n\n- Fill this gap: Remember-me path not handled\. \(src\/auth\/remember\.ts\)\n- Revert this, I didn’t ask for it: Renamed parseNext to readReturnUrl\.\n\n/,
    );
  });

  it('asks the agent to check each item before changing code for it', () => {
    const prompt = buildReworkPrompt([buildReviewSummary({ brief, confidence }).risks[1]]);
    expect(prompt).toContain('check it first');
    expect(prompt).toContain('failing test first');
    expect(prompt).toContain('break the code, watch the test fail, then restore it');
    expect(prompt).toContain('stop and tell me before writing it');
    expect(prompt).toContain('never by adding');
    expect(prompt).toContain('say why and leave it for me to decide');
    expect(prompt).toContain('evidence');
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
});
