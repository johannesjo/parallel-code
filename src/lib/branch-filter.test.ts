import { describe, expect, it } from 'vitest';
import { clampHighlight, filterBranches, matchExactBranch, resolveOnBlur } from './branch-filter';

describe('filterBranches', () => {
  const branches = ['main', 'develop', 'feature/login', 'feature/logout', 'fix/main-crash'];

  it('returns the full list for an empty query', () => {
    expect(filterBranches(branches, '')).toEqual(branches);
    expect(filterBranches(branches, '   ')).toEqual(branches);
  });

  it('matches case-insensitively', () => {
    expect(filterBranches(branches, 'FEATURE')).toEqual(['feature/login', 'feature/logout']);
  });

  it('matches substrings anywhere in the name', () => {
    expect(filterBranches(branches, 'log')).toEqual(['feature/login', 'feature/logout']);
  });

  it('orders prefix matches before substring matches', () => {
    expect(filterBranches(branches, 'main')).toEqual(['main', 'fix/main-crash']);
  });

  it('keeps original order among multiple prefix matches', () => {
    expect(filterBranches(branches, 'feature/log')).toEqual(['feature/login', 'feature/logout']);
  });

  it('ranks a case-insensitive prefix match above a substring match', () => {
    expect(filterBranches(['x-fea', 'Feature/b'], 'fea')).toEqual(['Feature/b', 'x-fea']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterBranches(branches, 'nope')).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [...branches];
    filterBranches(input, 'feature');
    expect(input).toEqual(branches);
  });
});

describe('matchExactBranch', () => {
  const branches = ['main', 'develop', 'feature/login'];

  it('returns the branch on an exact case-insensitive match', () => {
    expect(matchExactBranch(branches, 'main')).toBe('main');
    expect(matchExactBranch(branches, 'MAIN')).toBe('main');
    expect(matchExactBranch(branches, '  develop  ')).toBe('develop');
  });

  it('returns null for a partial match', () => {
    expect(matchExactBranch(branches, 'feat')).toBeNull();
  });

  it('returns null for an empty query', () => {
    expect(matchExactBranch(branches, '')).toBeNull();
  });

  it('returns null when the branch does not exist', () => {
    expect(matchExactBranch(branches, 'release')).toBeNull();
  });
});

describe('clampHighlight', () => {
  it('leaves an in-range index unchanged', () => {
    expect(clampHighlight(2, 5)).toBe(2);
  });

  it('clamps an index past the end down to the last option', () => {
    expect(clampHighlight(9, 5)).toBe(4);
  });

  it('clamps a negative index up to the first option', () => {
    expect(clampHighlight(-3, 5)).toBe(0);
  });

  it('pins the index at 0 for an empty list', () => {
    // Guards the ArrowDown bug: count - 1 would be -1 and index matches()[-1].
    expect(clampHighlight(0, 0)).toBe(0);
    expect(clampHighlight(1, 0)).toBe(0);
    expect(clampHighlight(-1, 0)).toBe(0);
  });
});

describe('resolveOnBlur', () => {
  const branches = ['main', 'develop', 'feature/login'];

  it('keeps the committed value when untouched', () => {
    // Even text that names a branch is ignored while dirty is false.
    expect(resolveOnBlur(branches, 'develop', false, 'main')).toBe('main');
  });

  it('resolves to a fully-typed branch name when dirty', () => {
    expect(resolveOnBlur(branches, 'develop', true, 'main')).toBe('develop');
    expect(resolveOnBlur(branches, '  DEVELOP  ', true, 'main')).toBe('develop');
  });

  it('discards partial or unmatched text and keeps the committed value', () => {
    expect(resolveOnBlur(branches, 'feat', true, 'main')).toBe('main');
    expect(resolveOnBlur(branches, 'nope', true, 'main')).toBe('main');
    expect(resolveOnBlur(branches, '', true, 'main')).toBe('main');
  });
});
