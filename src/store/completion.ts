import { produce } from 'solid-js/store';
import { parseGitHubUrl } from '../lib/github-url';
import { getLocalDateKey } from '../lib/date';
import { store, setStore } from './core';

function mergedPrKey(prUrl: string | undefined): string | undefined {
  const parsed = prUrl ? parseGitHubUrl(prUrl) : null;
  if (!prUrl || !parsed || parsed.type !== 'pull' || !parsed.number) return undefined;
  const host = new URL(prUrl).hostname.toLowerCase().replace(/^www\./, '');
  return `${host}/${parsed.org}/${parsed.repo}/${parsed.number}`.toLowerCase();
}

/** Local and remote merges of the same PR share the daily deduplication key. */
export function recordTaskMerged(prUrl?: string): boolean {
  const today = getLocalDateKey();
  const key = mergedPrKey(prUrl);
  if (key && store.completedTaskDate === today && store.countedMergedPrs.includes(key))
    return false;
  setStore(
    produce((s) => {
      if (s.completedTaskDate !== today) {
        s.completedTaskDate = today;
        s.completedTaskCount = 0;
        s.countedMergedPrs = [];
      }
      s.completedTaskCount += 1;
      if (key) s.countedMergedPrs.push(key);
    }),
  );
  return true;
}

export function getMergedTasksTodayCount(): number {
  return store.completedTaskDate === getLocalDateKey() ? store.completedTaskCount : 0;
}

export function recordMergedLines(linesAdded: number, linesRemoved: number): void {
  const safeAdded = Number.isFinite(linesAdded) ? Math.max(0, Math.floor(linesAdded)) : 0;
  const safeRemoved = Number.isFinite(linesRemoved) ? Math.max(0, Math.floor(linesRemoved)) : 0;
  if (safeAdded === 0 && safeRemoved === 0) return;

  setStore(
    produce((s) => {
      s.mergedLinesAdded += safeAdded;
      s.mergedLinesRemoved += safeRemoved;
    }),
  );
}

/** Count each tracked PR once on its actual local merge date, including after restart. */
export function recordRemotePrMerged(prUrl: string, mergedAt: string): boolean {
  const mergedDate = new Date(mergedAt);
  if (!Number.isFinite(mergedDate.getTime()) || getLocalDateKey(mergedDate) !== getLocalDateKey())
    return false;
  if (!mergedPrKey(prUrl)) return false;
  return recordTaskMerged(prUrl);
}
