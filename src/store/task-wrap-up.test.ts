import { describe, expect, it } from 'vitest';
import type { PrChecksState } from './pr-checks-state';
import { wrapUp, type WrapUpInput } from './task-wrap-up';

const pr = (overrides: Partial<PrChecksState> = {}): PrChecksState => ({
  overall: 'none',
  merged: true,
  headSha: 'abc',
  passing: 0,
  pending: 0,
  failing: 0,
  checks: [],
  checkedAt: '2026-11-13T00:00:00Z',
  ...overrides,
});

const input = (overrides: Partial<WrapUpInput> = {}): WrapUpInput => ({
  prs: [pr()],
  prsComplete: true,
  primaryPr: pr(),
  git: { uncommitted: false, headSha: 'abc' },
  finishItems: 0,
  ...overrides,
});

describe('wrapUp', () => {
  it('is done once the PR merged, the tree is clean and HEAD is what merged', () => {
    expect(wrapUp(input())).toEqual({ done: true, merged: true, looseEnds: [] });
  });

  it('names recorded loose ends while a PR is still open', () => {
    const open = { prs: [pr({ merged: false })] };
    expect(wrapUp(input({ ...open, finishItems: 2 }))).toEqual({
      done: false,
      merged: false,
      looseEnds: ['2 loose ends'],
    });
    expect(wrapUp(input({ ...open, finishItems: 1 })).looseEnds).toEqual(['1 loose end']);
  });

  it('drops recorded loose ends once every PR merged: merging settled them', () => {
    expect(wrapUp(input({ finishItems: 2 }))).toEqual({ done: true, merged: true, looseEnds: [] });
  });

  it('names uncommitted changes after the merge', () => {
    const result = wrapUp(input({ git: { uncommitted: true, headSha: 'abc' } }));
    expect(result).toEqual({ done: false, merged: true, looseEnds: ['Uncommitted changes'] });
  });

  it('names commits made after the merge', () => {
    const result = wrapUp(input({ git: { uncommitted: false, headSha: 'def' } }));
    expect(result).toEqual({ done: false, merged: true, looseEnds: ['Differs from merged PR'] });
  });

  it('cannot vouch for commits when the merged head is unknown', () => {
    expect(wrapUp(input({ primaryPr: pr({ headSha: undefined }) }))).toEqual({
      done: false,
      merged: true,
      looseEnds: ['Later commits not checked'],
    });
    // Only additional PRs, e.g. in a nested repository: the task's own HEAD is not theirs.
    expect(wrapUp(input({ primaryPr: undefined })).done).toBe(false);
  });

  it('is not done while a PR is open or not reported yet', () => {
    expect(wrapUp(input({ prs: [pr(), pr({ merged: false })] }))).toEqual({
      done: false,
      merged: false,
      looseEnds: [],
    });
    expect(wrapUp(input({ prs: [pr(), undefined] })).done).toBe(false);
  });

  it('is not done without any PR, but still names recorded loose ends', () => {
    expect(wrapUp(input({ prs: [], primaryPr: undefined, finishItems: 3 }))).toEqual({
      done: false,
      merged: false,
      looseEnds: ['3 loose ends'],
    });
  });

  it('is not done until every PR of the task has been listed', () => {
    expect(wrapUp(input({ prsComplete: false }))).toEqual({
      done: false,
      merged: false,
      looseEnds: [],
    });
    // Loose ends still count then: a PR in another repository may yet be open.
    expect(wrapUp(input({ prsComplete: false, finishItems: 2 })).looseEnds).toEqual([
      '2 loose ends',
    ]);
  });

  it('is not done while git status is unknown', () => {
    expect(wrapUp(input({ git: null }))).toEqual({ done: false, merged: true, looseEnds: [] });
  });
});
