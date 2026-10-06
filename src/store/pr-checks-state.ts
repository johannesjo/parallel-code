import { createStore, produce, unwrap } from 'solid-js/store';
import type { PrChecksOverall, PrChecksUpdatePayload, PrCheckRun } from '../ipc/types';

export interface PrChecksState {
  overall: PrChecksOverall;
  isDraft?: boolean;
  reviewDecision?: PrChecksUpdatePayload['reviewDecision'];
  /** The PR was merged on GitHub; the main process no longer watches it. */
  merged?: boolean;
  passing: number;
  pending: number;
  failing: number;
  checks: PrCheckRun[];
  checkedAt: string;
}

// createStore gives fine-grained per-key reactivity: updating one task's state
// only re-runs accessors that read that task's key, not every PR-aware view.
const [prChecks, setPrChecksStore] = createStore<Record<string, PrChecksState>>({});

export function getPrChecks(taskId: string): PrChecksState | undefined {
  return prChecks[taskId];
}

export function setPrChecks(taskId: string, next: PrChecksState): void {
  setPrChecksStore(taskId, next);
}

export function removePrChecks(taskId: string): void {
  if (!(taskId in unwrap(prChecks))) return;
  setPrChecksStore(
    produce((s) => {
      delete s[taskId];
    }),
  );
}
