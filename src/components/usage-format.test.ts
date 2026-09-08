import { describe, expect, it } from 'vitest';
import type { UsageState } from '../store/types';
import { formatFetchedAt, formatReset, remainingPercent, usageVisible } from './usage-format';

const NOON = new Date(2026, 8, 2, 12, 0, 0).getTime();

describe('remainingPercent', () => {
  it('rounds and never goes negative', () => {
    expect(remainingPercent({ usedPercent: 37.6, resetsAt: null })).toBe(62);
    expect(remainingPercent({ usedPercent: 100, resetsAt: null })).toBe(0);
  });
});

describe('formatReset', () => {
  it('is empty when the reset time is unknown', () => {
    expect(formatReset(null, NOON)).toBe('');
  });

  it('says the reset is due once the time has passed', () => {
    expect(formatReset(NOON - 60_000, NOON)).toBe('reset due');
    expect(formatReset(NOON, NOON)).toBe('reset due');
  });

  it('shows only the time for a reset later today', () => {
    const label = formatReset(NOON + 2 * 60 * 60_000, NOON);
    expect(label).toMatch(/^resets \d{1,2}:\d{2}/);
    expect(label).not.toMatch(/Wed|Thu/);
  });

  it('adds the weekday for a reset on another day', () => {
    const label = formatReset(NOON + 3 * 24 * 60 * 60_000, NOON);
    expect(label).toMatch(/^resets [A-Za-z]{2,4}\.? \d{1,2}:\d{2}/);
  });
});

describe('formatFetchedAt', () => {
  it('shows only the time for a fetch made today', () => {
    expect(formatFetchedAt(NOON - 60_000, NOON)).toMatch(/^\d{1,2}:\d{2}/);
  });

  it('adds the weekday for an older snapshot', () => {
    expect(formatFetchedAt(NOON - 2 * 24 * 60 * 60_000, NOON)).toMatch(
      /^[A-Za-z]{2,4}\.? \d{1,2}:\d{2}/,
    );
  });
});

describe('usageVisible', () => {
  const idle: UsageState = {
    fiveHour: null,
    sevenDay: null,
    fetchedAt: null,
    status: 'idle',
    error: null,
  };

  it('hides idle and unavailable providers without a snapshot', () => {
    expect(usageVisible(idle)).toBe(false);
    expect(usageVisible({ ...idle, status: 'unavailable', error: 'no login' })).toBe(false);
  });

  it('shows a provider with any window, and an error even without one', () => {
    expect(usageVisible({ ...idle, sevenDay: { usedPercent: 1, resetsAt: null } })).toBe(true);
    expect(usageVisible({ ...idle, status: 'error', error: 'HTTP 401' })).toBe(true);
  });
});
