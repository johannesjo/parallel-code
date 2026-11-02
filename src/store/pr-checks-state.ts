import { createStore, produce, unwrap } from 'solid-js/store';
import type { PrChecksOverall, PrChecksUpdatePayload, PrCheckRun, TaskExtraPr } from '../ipc/types';

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
  headSha?: string;
  checkedAt: string;
}

/** A watcher update as stored state. */
export function checksFromUpdate(msg: Partial<PrChecksUpdatePayload>): PrChecksState {
  return {
    overall: msg.overall as PrChecksOverall,
    // Explicit: store writes shallow-merge, so an omitted flag would keep a
    // previous PR's `merged: true`.
    merged: false,
    isDraft: msg.isDraft === true,
    reviewDecision:
      msg.reviewDecision === 'APPROVED' ||
      msg.reviewDecision === 'CHANGES_REQUESTED' ||
      msg.reviewDecision === 'REVIEW_REQUIRED'
        ? msg.reviewDecision
        : null,
    mergeable:
      msg.mergeable === 'MERGEABLE' || msg.mergeable === 'CONFLICTING' ? msg.mergeable : 'UNKNOWN',
    passing: typeof msg.passing === 'number' ? msg.passing : 0,
    pending: typeof msg.pending === 'number' ? msg.pending : 0,
    failing: typeof msg.failing === 'number' ? msg.failing : 0,
    checks: Array.isArray(msg.checks) ? (msg.checks as PrCheckRun[]) : [],
    headSha: typeof msg.headSha === 'string' && msg.headSha ? msg.headSha : undefined,
    checkedAt: typeof msg.checkedAt === 'string' ? msg.checkedAt : new Date().toISOString(),
  };
}

// createStore gives fine-grained per-key reactivity: updating one task's state
// only re-runs accessors that read that task's key, not every PR-aware view.
// Keyed by watcher ID: the task ID for a task's primary PR, `extraPrWatchId`
// for its additional ones.
const [prChecks, setPrChecksStore] = createStore<Record<string, PrChecksState>>({});
// Not persisted: detection finds the open ones again shortly after startup.
const [extraPrs, setExtraPrsStore] = createStore<Record<string, TaskExtraPr[]>>({});

/** Watcher ID of a task's additional PR; its checks are stored under this key. */
export function extraPrWatchId(taskId: string, url: string): string {
  return `${taskId}|${url}`;
}

/** A task's open PRs besides its primary one, e.g. those of its nested repositories. */
export function getTaskExtraPrs(taskId: string): TaskExtraPr[] {
  return extraPrs[taskId] ?? [];
}

export function setTaskExtraPrs(taskId: string, next: TaskExtraPr[]): void {
  const current = unwrap(extraPrs)[taskId] ?? [];
  const unchanged =
    current.length === next.length &&
    current.every((pr, i) => pr.url === next[i]?.url && pr.repo === next[i]?.repo);
  if (unchanged) return;
  setExtraPrsStore(
    produce((s) => {
      if (next.length > 0) s[taskId] = next;
      else delete s[taskId];
    }),
  );
}

/** Tasks that currently have additional PRs; read untracked. */
export function taskIdsWithExtraPrs(): string[] {
  return Object.keys(unwrap(extraPrs));
}

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

/** CI is green and nothing the PR state knows of blocks a merge. Branch
 *  protection beyond review and conflicts is left to GitHub at merge time. */
export function isPrReadyToMerge(c: PrChecksState | undefined): boolean {
  return (
    !!c &&
    c.overall === 'success' &&
    !c.merged &&
    !c.isDraft &&
    c.mergeable !== 'CONFLICTING' &&
    c.reviewDecision !== 'CHANGES_REQUESTED' &&
    c.reviewDecision !== 'REVIEW_REQUIRED'
  );
}

export type PrBoardStatusKind = 'merged' | 'ready' | 'blocked' | 'running' | 'failed';

/** What a board card says about its task's PR, most decisive state first. */
export function prBoardStatus(
  c: PrChecksState | undefined,
): { kind: PrBoardStatusKind; label: string } | null {
  if (!c) return null;
  if (c.merged) return { kind: 'merged', label: 'Merged' };
  if (isPrReadyToMerge(c)) return { kind: 'ready', label: 'Ready to merge' };
  // The watcher adds a failing check for conflicts, and GitHub runs no CI on a
  // conflicted branch; a lone failure is then the conflict, not the CI.
  if (c.overall === 'failure' && c.mergeable === 'CONFLICTING' && c.failing === 1)
    return { kind: 'blocked', label: 'Conflicts' };
  if (c.overall === 'failure') return { kind: 'failed', label: 'CI failed' };
  if (c.overall === 'pending') return { kind: 'running', label: 'CI running' };
  // Green CI held back by the PR itself: name what still stands in the way.
  if (c.overall === 'success') {
    if (c.mergeable === 'CONFLICTING') return { kind: 'blocked', label: 'CI passed · Conflicts' };
    if (c.isDraft) return { kind: 'blocked', label: 'CI passed · Draft' };
    if (c.reviewDecision === 'CHANGES_REQUESTED')
      return { kind: 'blocked', label: 'CI passed · Changes requested' };
    return { kind: 'blocked', label: 'CI passed · Review needed' };
  }
  return null;
}
