import { describe, expect, it } from 'vitest';
import { prBoardStatus, type PrChecksState } from './pr-checks-state';

const green: PrChecksState = {
  overall: 'success',
  merged: false,
  isDraft: false,
  reviewDecision: null,
  mergeable: 'MERGEABLE',
  passing: 3,
  pending: 0,
  failing: 0,
  checks: [],
  checkedAt: '2026-01-01T00:00:00Z',
};

describe('prBoardStatus', () => {
  it('has nothing to say before the watcher reports', () => {
    expect(prBoardStatus(undefined)).toBeNull();
    expect(prBoardStatus({ ...green, overall: 'none' })).toBeNull();
  });

  it('calls a green, unblocked PR ready to merge', () => {
    expect(prBoardStatus(green)?.label).toBe('Ready to merge');
    expect(prBoardStatus({ ...green, reviewDecision: 'APPROVED' })?.kind).toBe('ready');
  });

  it('says merged even though a merged PR reports no checks', () => {
    expect(prBoardStatus({ ...green, overall: 'none', merged: true })).toEqual({
      kind: 'merged',
      label: 'Merged',
    });
  });

  it('names what holds back a green PR', () => {
    expect(prBoardStatus({ ...green, mergeable: 'CONFLICTING' })?.label).toBe(
      'CI passed · Conflicts',
    );
    expect(prBoardStatus({ ...green, isDraft: true })?.label).toBe('CI passed · Draft');
    expect(prBoardStatus({ ...green, reviewDecision: 'CHANGES_REQUESTED' })?.label).toBe(
      'CI passed · Changes requested',
    );
    expect(prBoardStatus({ ...green, reviewDecision: 'REVIEW_REQUIRED' })?.label).toBe(
      'CI passed · Review needed',
    );
  });

  it('reports running and failed CI', () => {
    expect(prBoardStatus({ ...green, overall: 'pending' })?.kind).toBe('running');
    expect(prBoardStatus({ ...green, overall: 'failure' })?.kind).toBe('failed');
  });

  it('calls a conflict a conflict, not failed CI', () => {
    // The watcher adds a failing "Merge conflicts" check to every conflicted PR.
    const conflicted = { ...green, overall: 'failure' as const, mergeable: 'CONFLICTING' as const };
    expect(prBoardStatus({ ...conflicted, failing: 1 })).toEqual({
      kind: 'blocked',
      label: 'Conflicts',
    });
    expect(prBoardStatus({ ...conflicted, failing: 2 })?.label).toBe('CI failed');
  });
});
