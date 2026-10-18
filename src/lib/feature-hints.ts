/**
 * One-time tips that point at a feature the first time it can be used, e.g. a
 * change tour once a task has changes. They are not a tour of the app: each
 * shows only once its feature has something to work on.
 */
const FEATURE_HINT_IDS = ['change-tour', 'finish-review', 'delegate-subtasks'] as const;

export type FeatureHintId = (typeof FEATURE_HINT_IDS)[number];

export function isFeatureHintId(value: unknown): value is FeatureHintId {
  return FEATURE_HINT_IDS.some((id) => id === value);
}
