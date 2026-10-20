import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewScrollTarget } from './ReviewProvider';
import {
  REVIEW_NAVIGATION_HIGHLIGHT_MS,
  expandCollapsedFileForNavigation,
  scheduleReviewNavigationHighlightClear,
} from './review-navigation';

afterEach(() => {
  vi.useRealTimers();
});

describe('review navigation', () => {
  it('expands a collapsed target without changing an already-expanded set', () => {
    const collapsed = new Set(['src/app.ts', 'src/other.ts']);
    const expanded = expandCollapsedFileForNavigation(collapsed, 'src/app.ts');

    expect([...expanded]).toEqual(['src/other.ts']);
    expect(expandCollapsedFileForNavigation(expanded, 'src/app.ts')).toBe(expanded);
  });

  it('keeps the target active for the highlight interval before clearing it', () => {
    vi.useFakeTimers();
    const target: ReviewScrollTarget = { filePath: 'src/app.ts', startLine: 10 };
    let currentTarget: ReviewScrollTarget | null = target;
    const clearTarget = vi.fn(() => {
      currentTarget = null;
    });

    scheduleReviewNavigationHighlightClear(target, () => currentTarget, clearTarget);

    vi.advanceTimersByTime(REVIEW_NAVIGATION_HIGHLIGHT_MS - 1);
    expect(clearTarget).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(clearTarget).toHaveBeenCalledOnce();
    expect(currentTarget).toBeNull();
  });

  it('does not clear a newer navigation target', () => {
    vi.useFakeTimers();
    const target: ReviewScrollTarget = { filePath: 'src/app.ts', startLine: 10 };
    const currentTarget: ReviewScrollTarget = { filePath: 'src/other.ts', startLine: 20 };
    const clearTarget = vi.fn();

    scheduleReviewNavigationHighlightClear(target, () => currentTarget, clearTarget);
    vi.runAllTimers();

    expect(clearTarget).not.toHaveBeenCalled();
  });
});
