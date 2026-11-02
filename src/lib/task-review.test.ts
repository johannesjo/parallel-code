import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_MODEL,
  buildTaskReviewPrompt,
  parseTaskReviewResponse,
  restoreReviewModel,
  withReviewEffort,
} from './task-review';

const DIFF =
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new';

const input = {
  taskName: 'Fix login',
  prompts: ['Fix the redirect', 'Also keep ?next='],
  rawDiff: DIFF,
  dismissed: [],
};

describe('buildTaskReviewPrompt', () => {
  it('puts every prompt and the diff in front of the reviewer as data', () => {
    const prompt = buildTaskReviewPrompt(input);
    expect(prompt).toContain('You did not write this code.');
    expect(prompt.indexOf('Fix the redirect')).toBeLessThan(prompt.indexOf('Also keep ?next='));
    expect(prompt).toMatch(/<repo-content>[\s\S]*\+new[\s\S]*<\/repo-content>/);
    expect(prompt).not.toContain("The user's guidance");
  });

  it('adds the guidance and the risks the user set aside', () => {
    const prompt = buildTaskReviewPrompt({
      ...input,
      guidance: '  Weigh missing tests heavily.  ',
      dismissed: [{ text: 'No real provider.', reason: 'CI covers it' }],
    });
    expect(prompt).toContain("The user's guidance for reviews:\nWeigh missing tests heavily.");
    expect(prompt).toContain('- No real provider. (CI covers it)');
  });

  it('holds the reviewer to an audit: read before claiming, no deduction without a finding', () => {
    const prompt = buildTaskReviewPrompt(input);
    expect(prompt).toContain(
      'Report a gap or a risk only once you have read the code that shows it',
    );
    expect(prompt).toContain('A doubt you did not confirm that way is "unverified"');
    expect(prompt).toContain('make the strongest case that each score is wrong');
    expect(prompt).toContain(
      'Do not run tests, builds or the app yourself; the checks listed below ran',
    );
    expect(prompt).not.toContain('Do not run anything');
    expect(prompt).toContain('with no such finding, the score is 100');
    expect(prompt).toContain('"verified":string[]');
    // A test result counts as checked only when the checks section shows it.
    expect(prompt).not.toContain('unit tests passed');
    expect(prompt).toContain('a check result only when it is listed under Checks');
  });

  it('gives the reviewer the results of the checks it ran, as data', () => {
    const prompt = buildTaskReviewPrompt({
      ...input,
      checks: [
        { name: 'Unit tests', result: 'passed' },
        { name: 'E2E', result: 'skipped: dirty' },
      ],
    });
    expect(prompt).toMatch(
      /## Checks run on this code\n<repo-content>[\s\S]*- Unit tests: passed\n- E2E: skipped: dirty[\s\S]*<\/repo-content>/,
    );
    expect(buildTaskReviewPrompt(input)).toMatch(
      /## Checks run on this code\n<repo-content>\s*\(none ran\)/,
    );
  });

  it('tells an unreadable diff apart from no changes and no prompts', () => {
    expect(buildTaskReviewPrompt({ ...input, rawDiff: undefined })).toContain(
      'the diff could not be read',
    );
    const empty = buildTaskReviewPrompt({ ...input, rawDiff: '', prompts: [] });
    expect(empty).toContain('(no changes)');
    expect(empty).toContain('(none recorded; judge by the task name)');
  });
});

describe('parseTaskReviewResponse', () => {
  it('reads the rating and names its source', () => {
    const rating = parseTaskReviewResponse(
      'Here it is: {"scores":[{"label":"Correct","score":80,"why":"No test."}],"findings":[{"kind":"gap","text":"Missing ?next=.","file":"src/a.ts"}]}',
      'Review by opus',
    );
    expect(rating).toEqual({
      scores: [{ label: 'Correct', score: 80, why: 'No test.' }],
      findings: [{ kind: 'gap', text: 'Missing ?next=.', file: 'src/a.ts' }],
      source: 'Review by opus',
    });
  });

  it('keeps the score a finding lowers, dropping one that is not text', () => {
    const rating = parseTaskReviewResponse(
      JSON.stringify({
        scores: [{ label: 'Complete', score: 60, why: 'x' }],
        findings: [
          { kind: 'gap', axis: 'Complete', text: 'No .env.example.' },
          { kind: 'risk', axis: 3, text: 'Key is logged.' },
        ],
      }),
      'Review by opus',
    );
    expect(rating.findings).toEqual([
      { kind: 'gap', axis: 'Complete', text: 'No .env.example.' },
      { kind: 'risk', text: 'Key is logged.' },
    ]);
  });

  it('keeps a doubt the reviewer did not confirm apart from gaps and risks', () => {
    const rating = parseTaskReviewResponse(
      JSON.stringify({
        scores: [{ label: 'Correct', score: 85, why: 'x' }],
        findings: [
          { kind: 'unverified', axis: 'Correct', text: 'Retry only runs on a real network.' },
        ],
      }),
      'Review by opus',
    );
    expect(rating.findings).toEqual([
      { kind: 'unverified', axis: 'Correct', text: 'Retry only runs on a real network.' },
    ]);
  });

  it('trims an overlong answer to the limits instead of failing', () => {
    const rating = parseTaskReviewResponse(
      JSON.stringify({
        scores: Array.from({ length: 9 }, (_, i) => ({
          label: `Score ${i}`,
          score: 50,
          why: 'x'.repeat(500),
        })),
        findings: Array.from({ length: 14 }, (_, i) => ({ kind: 'risk', text: `Risk ${i}` })),
      }),
      'Review by opus',
    );
    expect(rating.scores).toHaveLength(6);
    expect(rating.scores[0].why).toHaveLength(240);
    expect(rating.findings).toHaveLength(10);
  });

  it('trims what a score was checked against instead of failing', () => {
    const rating = parseTaskReviewResponse(
      JSON.stringify({
        scores: [
          { label: 'Correct', score: 80, why: 'x', verified: [1, 'a'.repeat(200), 'b', 'c', 'd'] },
          { label: 'Minimal', score: 90, why: 'x', verified: 'read it' },
        ],
        findings: [],
      }),
      'Review by opus',
    );
    expect(rating.scores[0].verified).toEqual(['a'.repeat(120), 'b', 'c']);
    expect(rating.scores[1].verified).toBeUndefined();
  });

  it('keeps what was asked, the changes and the key line, dropping a broken key line', () => {
    const rating = parseTaskReviewResponse(
      JSON.stringify({
        asked: 'Keep ?next= through sign-in.',
        changes: [{ now: 'You land where you were going', before: 'instead of /', tested: 'unit' }],
        keyLine: { file: 'src/a.ts', line: 3, why: 'The redirect guard.' },
        scores: [{ label: 'Correct', score: 80, why: 'No test.' }],
      }),
      'Review by opus',
    );
    expect(rating).toMatchObject({
      asked: 'Keep ?next= through sign-in.',
      changes: [{ now: 'You land where you were going', before: 'instead of /', tested: 'unit' }],
      keyLine: { file: 'src/a.ts', line: 3, why: 'The redirect guard.' },
    });
    const broken = parseTaskReviewResponse(
      JSON.stringify({
        keyLine: { file: 'src/a.ts', line: 'top', why: 'x' },
        scores: [{ label: 'Correct', score: 80, why: 'No test.' }],
      }),
      'Review by opus',
    );
    expect(broken.keyLine).toEqual({ file: 'src/a.ts', why: 'x' });
    expect(broken.changes).toBeUndefined();
  });

  it('throws when there is no rating', () => {
    expect(() => parseTaskReviewResponse('Looks good!', 'Review by opus')).toThrow();
  });
});

describe('restoreReviewModel', () => {
  it('keeps a saved choice and falls back on anything else', () => {
    expect(restoreReviewModel({ provider: 'codex', model: ' gpt-5 ', effort: 'high' })).toEqual({
      provider: 'codex',
      model: 'gpt-5',
      effort: 'high',
    });
    expect(restoreReviewModel(undefined)).toEqual(DEFAULT_REVIEW_MODEL);
    expect(restoreReviewModel(['claude'])).toEqual(DEFAULT_REVIEW_MODEL);
    expect(restoreReviewModel({ provider: 'other', model: 7 })).toEqual({ provider: 'claude' });
  });
});

describe('withReviewEffort', () => {
  it('runs a Claude reviewer with no level chosen at high, leaving a chosen level and Codex alone', () => {
    expect(withReviewEffort({ provider: 'claude', model: 'opus' })).toEqual({
      provider: 'claude',
      model: 'opus',
      effort: 'high',
    });
    expect(withReviewEffort({ provider: 'claude', effort: 'low' })).toEqual({
      provider: 'claude',
      effort: 'low',
    });
    expect(withReviewEffort({ provider: 'codex' })).toEqual({ provider: 'codex' });
  });
});
