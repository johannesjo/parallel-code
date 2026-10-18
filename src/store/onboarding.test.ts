import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));

import { setStore, store } from './core';
import {
  activeFeatureHint,
  claimFeatureHint,
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
    expect(claimFeatureHint(first, 'change-tour')).toBe(true);
    expect(claimFeatureHint(second, 'finish-review')).toBe(false);
    expect(activeFeatureHint()).toBe('change-tour');

    releaseFeatureHint(second);
    expect(isFeatureHintActive(first)).toBe(true);

    releaseFeatureHint(first);
    expect(activeFeatureHint()).toBeNull();
    expect(claimFeatureHint(second, 'finish-review')).toBe(true);
    releaseFeatureHint(second);
  });

  it('frees the slot once the tip on screen is seen, then holds the next one back', () => {
    const first = Symbol('first');
    const second = Symbol('second');
    claimFeatureHint(first, 'change-tour');
    // Dismissing the tip and using its feature both land here.
    markFeatureHintSeen('change-tour');

    expect(featureHintWanted('change-tour')).toBe(false);
    expect(store.seenFeatureHints).toEqual(['change-tour']);
    expect(isFeatureHintActive(first)).toBe(false);
    expect(claimFeatureHint(second, 'finish-review')).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(claimFeatureHint(second, 'finish-review')).toBe(true);
    releaseFeatureHint(second);
  });

  it('leaves the tip on screen alone when another feature is used', () => {
    const owner = Symbol('owner');
    claimFeatureHint(owner, 'change-tour');
    markFeatureHintSeen('finish-review');
    expect(isFeatureHintActive(owner)).toBe(true);
    releaseFeatureHint(owner);
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
