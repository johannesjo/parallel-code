import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore, store } from './core';
import { getMergedTasksTodayCount, recordRemotePrMerged, recordTaskMerged } from './completion';

const pr = 'https://github.com/acme/app/pull/12';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 9, 12));
  setStore({ completedTaskDate: '2026-10-09', completedTaskCount: 0, countedMergedPrs: [] });
});
afterEach(() => vi.useRealTimers());

describe('remote PR merge counting', () => {
  it('combines local merges and unique remote PRs, ignoring URL decoration', () => {
    recordTaskMerged();
    expect(recordRemotePrMerged(pr, new Date().toISOString())).toBe(true);
    expect(recordRemotePrMerged(`${pr}/files#diff`, new Date().toISOString())).toBe(false);
    expect(
      recordRemotePrMerged('https://github.com/ACME/APP/pull/12', new Date().toISOString()),
    ).toBe(false);
    expect(getMergedTasksTodayCount()).toBe(2);
  });

  it('uses persisted keys to avoid recounting after restart', () => {
    setStore({ completedTaskCount: 1, countedMergedPrs: ['github.com/acme/app/12'] });
    expect(recordRemotePrMerged(pr, new Date().toISOString())).toBe(false);
    expect(getMergedTasksTodayCount()).toBe(1);
  });

  it('ignores old, invalid, and unknown merge dates', () => {
    for (const date of [new Date(2026, 9, 8, 12).toISOString(), '', 'invalid']) {
      expect(recordRemotePrMerged(pr, date)).toBe(false);
    }
    expect(getMergedTasksTodayCount()).toBe(0);
  });

  it('resets the count and deduplication keys on a new local day', () => {
    recordRemotePrMerged(pr, new Date().toISOString());
    vi.setSystemTime(new Date(2026, 9, 10, 12));
    expect(getMergedTasksTodayCount()).toBe(0);
    expect(
      recordRemotePrMerged('https://github.com/acme/app/pull/13', new Date().toISOString()),
    ).toBe(true);
    expect(getMergedTasksTodayCount()).toBe(1);
    expect(store.countedMergedPrs).toEqual(['github.com/acme/app/13']);
  });
});

describe('local and remote merges of the same task', () => {
  it.each(['remote-first', 'local-first'])('counts only once (%s)', (order) => {
    const remote = () => recordRemotePrMerged(pr, new Date().toISOString());
    const local = () => recordTaskMerged(`${pr}/files`);
    const [first, second] = order === 'remote-first' ? [remote, local] : [local, remote];
    expect(first()).toBe(true);
    expect(second()).toBe(false);
    expect(getMergedTasksTodayCount()).toBe(1);
    expect(store.countedMergedPrs).toEqual(['github.com/acme/app/12']);
  });

  it('still counts local tasks without a PR, including issue-linked tasks', () => {
    recordTaskMerged();
    recordTaskMerged('https://github.com/acme/app/issues/12');
    expect(getMergedTasksTodayCount()).toBe(2);
    expect(store.countedMergedPrs).toEqual([]);
  });
});
