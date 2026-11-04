import { CHECK_ID_PATTERN } from '../../electron/shared/checks';

/**
 * Which project checks a review runs besides the reviewer.
 * The choice is saved per project as check ids; the results are the task's
 * check suite, so the gate that holds risky checks back still applies.
 */

const MAX_REVIEW_CHECKS = 32;

/** Restores a saved pick; unset means the user has not picked yet. */
export function restoreReviewChecks(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter(
    (id): id is string => typeof id === 'string' && CHECK_ID_PATTERN.test(id),
  );
  return [...new Set(ids)].slice(0, MAX_REVIEW_CHECKS);
}
