import { describe, expect, it } from 'vitest';
import {
  detectBranchDivergence,
  isAdoptableBranch,
  sameDivergence,
  trackDivergence,
} from './branch-divergence';

const task = {
  branchName: 'task/foo',
  gitIsolation: 'worktree' as const,
};

function snapshot(current: string | null, overrides: Record<string, unknown> = {}) {
  return {
    current_branch: current,
    base_branch: 'main',
    refreshedAt: 1000,
    ...overrides,
  };
}

describe('detectBranchDivergence', () => {
  it('returns null when the worktree is on the task branch', () => {
    expect(detectBranchDivergence(task, snapshot('task/foo'))).toBeNull();
  });

  it('offers adoption when the agent switched to a feature branch', () => {
    expect(detectBranchDivergence(task, snapshot('fix/issue-1234'))).toEqual({
      kind: 'switched',
      branch: 'fix/issue-1234',
      adoptable: true,
    });
  });

  it('marks the base branch as not adoptable', () => {
    expect(detectBranchDivergence(task, snapshot('main'))).toEqual({
      kind: 'switched',
      branch: 'main',
      adoptable: false,
    });
  });

  it('marks the branch as not adoptable when the base is unknown', () => {
    // Near-unreachable (an unresolved base normally means an unreadable
    // worktree, which is filtered earlier), but the stakes of a false
    // "adoptable" are self-merge plus base deletion — default to safe.
    expect(detectBranchDivergence(task, snapshot('fix/x', { base_branch: null }))).toEqual({
      kind: 'switched',
      branch: 'fix/x',
      adoptable: false,
    });
  });

  it('prefers the task baseBranch over the snapshot base branch', () => {
    const result = detectBranchDivergence(
      { ...task, baseBranch: 'develop' },
      snapshot('develop', { base_branch: 'main' }),
    );
    expect(result).toEqual({ kind: 'switched', branch: 'develop', adoptable: false });
  });

  it('reports detached HEAD when the repo is readable', () => {
    expect(detectBranchDivergence(task, snapshot(null))).toEqual({ kind: 'detached' });
  });

  it('stays silent for an unreadable worktree (no branch, no base)', () => {
    expect(detectBranchDivergence(task, snapshot(null, { base_branch: null }))).toBeNull();
  });

  it('suppresses a divergence the user already dismissed', () => {
    expect(
      detectBranchDivergence(
        { ...task, branchOfferDismissed: 'fix/issue-1234' },
        snapshot('fix/issue-1234'),
      ),
    ).toBeNull();
  });

  it('re-surfaces when the agent switches to a different branch than the dismissed one', () => {
    expect(
      detectBranchDivergence({ ...task, branchOfferDismissed: 'fix/old' }, snapshot('fix/new')),
    ).toEqual({ kind: 'switched', branch: 'fix/new', adoptable: true });
  });

  it('only applies to worktree-isolated tasks', () => {
    expect(
      detectBranchDivergence({ ...task, gitIsolation: 'direct' }, snapshot('fix/issue-1234')),
    ).toBeNull();
    expect(
      detectBranchDivergence({ ...task, gitIsolation: 'none' }, snapshot('fix/issue-1234')),
    ).toBeNull();
  });

  it('ignores missing, errored, stale, or never-refreshed snapshots', () => {
    expect(detectBranchDivergence(task, undefined)).toBeNull();
    expect(detectBranchDivergence(task, snapshot('fix/x', { error: 'boom' }))).toBeNull();
    expect(detectBranchDivergence(task, snapshot('fix/x', { stale: true }))).toBeNull();
    expect(detectBranchDivergence(task, snapshot('fix/x', { refreshedAt: 0 }))).toBeNull();
  });
});

describe('isAdoptableBranch', () => {
  it('allows feature branches, refuses the base branch and unknown bases', () => {
    expect(isAdoptableBranch('fix/a', 'main')).toBe(true);
    expect(isAdoptableBranch('main', 'main')).toBe(false);
    expect(isAdoptableBranch('fix/a', null)).toBe(false);
    expect(isAdoptableBranch('fix/a', undefined)).toBe(false);
  });

  it('refuses names the IPC branch validator rejects', () => {
    // git allows these in refnames; the IPC layer does not, and adopting one
    // would wedge every branch-parameterized call including task close.
    expect(isAdoptableBranch('pwn;x', 'main')).toBe(false);
    expect(isAdoptableBranch('feature/$(rm -rf)', 'main')).toBe(false);
    expect(isAdoptableBranch('feat`x`', 'main')).toBe(false);
    expect(isAdoptableBranch('feature/ok-name_1.2', 'main')).toBe(true);
  });
});

describe('trackDivergence', () => {
  const switched = { kind: 'switched', branch: 'fix/a', adoptable: true } as const;

  it('records the first sighting', () => {
    expect(trackDivergence(null, switched, 1000)).toEqual({
      key: 'switched:fix/a',
      firstSeenAt: 1000,
    });
  });

  it('keeps the same observation (by identity) while the divergence persists', () => {
    const first = trackDivergence(null, switched, 1000);
    expect(trackDivergence(first, switched, 2000)).toBe(first);
    expect(trackDivergence(first, switched, 1000)).toBe(first);
  });

  it('restarts when the divergence changes branch', () => {
    const first = trackDivergence(null, switched, 1000);
    const other = { kind: 'switched', branch: 'fix/b', adoptable: true } as const;
    expect(trackDivergence(first, other, 2000)).toEqual({
      key: 'switched:fix/b',
      firstSeenAt: 2000,
    });
  });

  it('treats detached HEAD as its own key', () => {
    const first = trackDivergence(null, switched, 1000);
    expect(trackDivergence(first, { kind: 'detached' }, 2000)).toEqual({
      key: 'detached',
      firstSeenAt: 2000,
    });
  });

  it('resets when the divergence disappears', () => {
    const first = trackDivergence(null, switched, 1000);
    expect(trackDivergence(first, null, 2000)).toBeNull();
  });
});

describe('sameDivergence', () => {
  it('compares structurally, including adoptability', () => {
    const a = { kind: 'switched', branch: 'fix/a', adoptable: true } as const;
    expect(sameDivergence(a, { ...a })).toBe(true);
    expect(sameDivergence(a, { ...a, branch: 'fix/b' })).toBe(false);
    expect(sameDivergence(a, { ...a, adoptable: false })).toBe(false);
    expect(sameDivergence({ kind: 'detached' }, { kind: 'detached' })).toBe(true);
    expect(sameDivergence(a, { kind: 'detached' })).toBe(false);
    expect(sameDivergence(null, null)).toBe(true);
    expect(sameDivergence(a, null)).toBe(false);
  });
});
