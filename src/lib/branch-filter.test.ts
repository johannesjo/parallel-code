import { describe, expect, it } from 'vitest';
import { filterBranches, matchExactBranch } from './branch-filter';

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
