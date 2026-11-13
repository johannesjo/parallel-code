import { describe, expect, it } from 'vitest';
import { changesSinceVisit, restoreTaskVisit } from './task-visit';

const visit = { at: 1_000, headSha: 'aaa' };

describe('changesSinceVisit', () => {
  it('reports nothing without a recorded visit', () => {
    expect(changesSinceVisit({ visit: undefined, headSha: 'bbb' })).toEqual([]);
  });

  it('reports new commits when HEAD moved since the visit', () => {
    expect(changesSinceVisit({ visit, headSha: 'bbb' })).toEqual(['new commits']);
  });

  it('stays quiet when HEAD is unchanged or unknown on either side', () => {
    expect(changesSinceVisit({ visit, headSha: 'aaa' })).toEqual([]);
    expect(changesSinceVisit({ visit, headSha: null })).toEqual([]);
    expect(changesSinceVisit({ visit: { at: 1_000 }, headSha: 'bbb' })).toEqual([]);
  });

  it('reports an outdated rating once code read after the visit differs from the rated diff', () => {
    const confidence = { publishedAt: 500, fingerprint: 'rated' };
    expect(
      changesSinceVisit({
        visit,
        headSha: 'aaa',
        confidence,
        codeFingerprint: { fingerprint: 'newer', at: 2_000 },
      }),
    ).toEqual(['rating outdated']);
  });

  it('does not repeat a rating that was already outdated before the visit', () => {
    expect(
      changesSinceVisit({
        visit,
        headSha: 'aaa',
        confidence: { publishedAt: 500, fingerprint: 'rated' },
        codeFingerprint: { fingerprint: 'newer', at: 800 },
      }),
    ).toEqual([]);
  });

  it('does not report an outdated rating again when unchanged code is merely re-read', () => {
    expect(
      changesSinceVisit({
        visit: { ...visit, codeFingerprint: 'newer' },
        headSha: 'aaa',
        confidence: { publishedAt: 500, fingerprint: 'rated' },
        codeFingerprint: { fingerprint: 'newer', at: 2_000 },
      }),
    ).toEqual([]);
  });

  it('falls back to the brief fingerprint when no diff fingerprint was read', () => {
    expect(
      changesSinceVisit({
        visit,
        headSha: 'aaa',
        confidence: { publishedAt: 500, fingerprint: 'rated' },
        brief: { generatedAt: 3_000, fingerprint: 'newer' },
      }),
    ).toEqual(['rating outdated']);
  });

  it('reports an app-run verify that failed after the visit; a pass asks nothing', () => {
    const finishedAfter = new Date(5_000).toISOString();
    const finishedBefore = new Date(500).toISOString();
    expect(
      changesSinceVisit({
        visit,
        headSha: 'aaa',
        verificationRun: { status: 'failed', finishedAt: finishedAfter },
      }),
    ).toEqual(['verify failed']);
    expect(
      changesSinceVisit({
        visit,
        headSha: 'aaa',
        verificationRun: { status: 'passed', finishedAt: finishedAfter },
      }),
    ).toEqual([]);
    expect(
      changesSinceVisit({
        visit,
        headSha: 'aaa',
        verificationRun: { status: 'failed', finishedAt: finishedBefore },
      }),
    ).toEqual([]);
    expect(
      changesSinceVisit({
        visit,
        headSha: 'aaa',
        verificationRun: { status: 'cancelled', finishedAt: finishedAfter },
      }),
    ).toEqual([]);
  });

  it('reports app-run suite checks that failed after the visit, skipping reused verify runs', () => {
    const after = new Date(5_000).toISOString();
    const before = new Date(500).toISOString();
    const check = (status: 'passed' | 'failed', finishedAt: string, reused?: boolean) => ({
      status,
      finishedAt,
      reused,
    });
    expect(
      changesSinceVisit({
        visit,
        headSha: 'aaa',
        checks: [check('passed', after), check('failed', after)],
      }),
    ).toEqual(['checks failed']);
    expect(changesSinceVisit({ visit, headSha: 'aaa', checks: [check('passed', after)] })).toEqual(
      [],
    );
    expect(
      changesSinceVisit({
        visit,
        headSha: 'aaa',
        checks: [check('failed', before), check('failed', after, true)],
      }),
    ).toEqual([]);
  });

  it('lists every change in a fixed order', () => {
    expect(
      changesSinceVisit({
        visit,
        headSha: 'bbb',
        confidence: { publishedAt: 500, fingerprint: 'rated' },
        codeFingerprint: { fingerprint: 'newer', at: 2_000 },
        verificationRun: { status: 'failed', finishedAt: new Date(5_000).toISOString() },
        checks: [{ status: 'failed', finishedAt: new Date(5_000).toISOString() }],
      }),
    ).toEqual(['new commits', 'rating outdated', 'verify failed', 'checks failed']);
  });
});

describe('restoreTaskVisit', () => {
  it('keeps a well-formed visit and drops malformed ones', () => {
    expect(restoreTaskVisit({ at: 5, headSha: 'abc', codeFingerprint: 'fp' })).toEqual({
      at: 5,
      headSha: 'abc',
      codeFingerprint: 'fp',
    });
    expect(restoreTaskVisit({ at: 5 })).toEqual({ at: 5 });
    expect(restoreTaskVisit({ at: 'x' })).toBeUndefined();
    expect(restoreTaskVisit(null)).toBeUndefined();
  });
});
