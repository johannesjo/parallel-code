import { parseGitHubUrl } from '../lib/github-url';
import {
  closedPrimaryPrUrl,
  extraPrWatchId,
  getPrChecks,
  getTaskExtraPrs,
  prBoardStatus,
  type PrBoardStatusKind,
  type PrChecksState,
} from './pr-checks-state';
import { store } from './core';
import type { Task } from './types';

// Which PRs a task has and which of them its status describes. Kept apart from
// the PR watcher in pr-checks.ts so task status code can read it without a cycle.

function parsePrUrl(url: string | undefined): string | null {
  if (!url) return null;
  const parsed = parseGitHubUrl(url);
  if (!parsed || parsed.type !== 'pull' || !parsed.number) return null;
  return url;
}

export function taskPrUrl(task: Task): string | null {
  return parsePrUrl(task.prUrl) ?? parsePrUrl(task.githubUrl);
}

/** A task's PRs, each with the watcher ID its checks are stored under: the
 *  primary one first, then its additional ones. A closed primary PR is left
 *  out: its checks are gone, and it no longer holds the task up. */
export function taskPrs(task: Task): { url: string; watchId: string; repo?: string }[] {
  const url = taskPrUrl(task);
  const primary = url && closedPrimaryPrUrl(task.id) !== url ? url : null;
  return [
    ...(primary ? [{ url: primary, watchId: task.id }] : []),
    ...getTaskExtraPrs(task.id).map((pr) => ({
      url: pr.url,
      watchId: extraPrWatchId(task.id, pr.url),
      ...(pr.repo ? { repo: pr.repo } : {}),
    })),
  ];
}

/** The checks of each of a task's PRs; undefined for a PR not reported yet. */
export function taskPrsChecks(task: Task): (PrChecksState | undefined)[] {
  return taskPrs(task).map((pr) => getPrChecks(pr.watchId));
}

// Lower is more urgent. A PR not reported yet ranks above ready ones: it keeps
// the task from being ready too.
const LEAD_RANK: Record<PrBoardStatusKind | 'unreported', number> = {
  failed: 0,
  blocked: 1,
  running: 2,
  unreported: 3,
  ready: 4,
  merged: 5,
};

/** The PR a task's status line describes: the open one that most needs
 *  attention, else a merged one; undefined for a task without PRs. */
export function taskLeadPr(task: Task): { url: string; watchId: string } | undefined {
  const rank = (watchId: string) =>
    LEAD_RANK[prBoardStatus(getPrChecks(watchId))?.kind ?? 'unreported'];
  let lead: { url: string; watchId: string } | undefined;
  for (const { url, watchId } of taskPrs(task)) {
    if (!lead || rank(watchId) < rank(lead.watchId)) lead = { url, watchId };
  }
  return lead;
}

/** The PR a task's card links: the one its status describes, else its own
 *  PR that closed unmerged, so the card still leads to it. */
export function taskLinkedPrUrl(task: Task): string | undefined {
  return taskLeadPr(task)?.url ?? taskPrUrl(task) ?? undefined;
}

/** Watcher ID of the PR a task's status describes; the task ID when it has none,
 *  where any checks would be stored. */
export function taskLeadWatchId(taskId: string): string {
  const task = store.tasks[taskId];
  return (task && taskLeadPr(task)?.watchId) ?? taskId;
}
