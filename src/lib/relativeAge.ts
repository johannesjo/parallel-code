/** Compact "how long ago" for sidebar rows: `just now`, `4m`, `2h`, `3d`. */
export function formatRelativeAge(since: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - since) / 1_000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
