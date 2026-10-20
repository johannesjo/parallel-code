import type { ReviewScrollTarget } from './ReviewProvider';

export const REVIEW_NAVIGATION_HIGHLIGHT_MS = 1200;

export function expandCollapsedFileForNavigation(
  collapsedFiles: ReadonlySet<string>,
  filePath: string,
): ReadonlySet<string> {
  if (!collapsedFiles.has(filePath)) return collapsedFiles;
  const expanded = new Set(collapsedFiles);
  expanded.delete(filePath);
  return expanded;
}

export function scheduleReviewNavigationHighlightClear(
  target: ReviewScrollTarget,
  currentTarget: () => ReviewScrollTarget | null | undefined,
  clearTarget: () => void,
  delay = REVIEW_NAVIGATION_HIGHLIGHT_MS,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (currentTarget() === target) clearTarget();
  }, delay);
}
