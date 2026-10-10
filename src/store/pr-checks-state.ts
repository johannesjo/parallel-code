import { createStore, produce, unwrap } from 'solid-js/store';
import type { PrChecksOverall, PrChecksUpdatePayload, PrCheckRun } from '../ipc/types';

export interface PrChecksState {
  overall: PrChecksOverall;
  isDraft?: boolean;
  reviewDecision?: PrChecksUpdatePayload['reviewDecision'];
  /** The PR was merged on GitHub; the main process no longer watches it. */
  merged?: boolean;
  mergeable?: PrChecksUpdatePayload['mergeable'];
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

/** The CI states a task's status glyph surfaces. Passing CI already shows as
 *  the green "Ready to merge" dot, so only running and failed runs appear here. */
export interface CiGlyphState {
  state: 'running' | 'failed';
  done: number;
  total: number;
  failing: number;
  /** Finished share of checks, 0–100. */
  progress: number;
}

export function getCiGlyphState(taskId: string): CiGlyphState | undefined {
  const c = prChecks[taskId];
  // A merged PR's last run no longer matters, even if it ended red.
  if (!c || c.merged) return undefined;
  if (c.overall !== 'pending' && c.overall !== 'failure') return undefined;
  const done = c.passing + c.failing;
  const total = done + c.pending;
  return {
    state: c.overall === 'pending' ? 'running' : 'failed',
    done,
    total,
    failing: c.failing,
    progress: total > 0 ? (done / total) * 100 : 0,
  };
}
