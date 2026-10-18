import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));

import { setStore, store } from './core';
import {
  claimFeatureHint,
  dismissFeatureHint,
  featureHintWanted,
  isFeatureHintActive,
  markFeatureHintSeen,
  releaseFeatureHint,
  setFeatureHintsEnabled,
} from './onboarding';

beforeEach(() => {
  vi.useFakeTimers();
  mockInvoke.mockResolvedValue(undefined);
  setStore('featureHintsEnabled', true);
  setStore('seenFeatureHints', []);
});

afterEach(() => {
  // Let any cooldown run out so it does not leak into the next test.
  vi.runAllTimers();
  vi.useRealTimers();
});

describe('feature tips', () => {
  it('shows one tip at a time and hands the slot on when it is released', () => {
    const first = Symbol('first');
    const second = Symbol('second');
    expect(claimFeatureHint(first)).toBe(true);
    expect(claimFeatureHint(second)).toBe(false);
    expect(isFeatureHintActive(second)).toBe(false);

    releaseFeatureHint(second);
    expect(isFeatureHintActive(first)).toBe(true);

    releaseFeatureHint(first);
    expect(claimFeatureHint(second)).toBe(true);
    releaseFeatureHint(second);
  });

  it('marks a dismissed tip seen and holds the next one back for a while', () => {
    const first = Symbol('first');
    const second = Symbol('second');
    claimFeatureHint(first);
    dismissFeatureHint('change-tour', first);

    expect(featureHintWanted('change-tour')).toBe(false);
    expect(store.seenFeatureHints).toEqual(['change-tour']);
    expect(claimFeatureHint(second)).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(claimFeatureHint(second)).toBe(true);
    releaseFeatureHint(second);
  });

  it('records a used feature once', () => {
    markFeatureHintSeen('finish-review');
    markFeatureHintSeen('finish-review');
    expect(store.seenFeatureHints).toEqual(['finish-review']);
  });

  it('shows no tips while turned off, and every tip again once turned back on', () => {
    markFeatureHintSeen('change-tour');
    setFeatureHintsEnabled(false);
    expect(featureHintWanted('delegate-subtasks')).toBe(false);

    setFeatureHintsEnabled(true);
    expect(store.seenFeatureHints).toEqual([]);
    expect(featureHintWanted('change-tour')).toBe(true);
  });
});
