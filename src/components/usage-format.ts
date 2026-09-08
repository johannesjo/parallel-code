import type { UsageWindow } from '../ipc/types';
import type { UsageState } from '../store/types';

/** Past this share of a window, the meter turns amber. */
export const USAGE_WARN_PERCENT = 80;

export function remainingPercent(window: UsageWindow): number {
  return Math.max(0, Math.round(100 - window.usedPercent));
}

/** "resets 14:30" for today, "resets Thu 09:00" otherwise, "reset due" once the
 *  time has passed (the API keeps reporting a window until the next request),
 *  '' when unknown. */
export function formatReset(resetsAt: number | null, now = Date.now()): string {
  if (resetsAt === null) return '';
  if (resetsAt <= now) return 'reset due';
  const date = new Date(resetsAt);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date(now).toDateString()) return `resets ${time}`;
  const day = date.toLocaleDateString(undefined, { weekday: 'short' });
  return `resets ${day} ${time}`;
}

/** "14:02" for a fetch made today, "Thu 14:02" for older snapshots. */
export function formatFetchedAt(fetchedAt: number, now = Date.now()): string {
  const date = new Date(fetchedAt);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

export function hasUsageSnapshot(state: UsageState): boolean {
  return state.fiveHour !== null || state.sevenDay !== null;
}

/** A provider shows once it has a snapshot, and stays up through refresh errors
 *  so the user sees why the meter stopped moving. */
export function usageVisible(state: UsageState): boolean {
  return hasUsageSnapshot(state) || state.status === 'error';
}
