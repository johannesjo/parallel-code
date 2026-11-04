import type { RemotePrStatusKind, RemoteTaskPr } from './protocol.js';

const PR_KINDS: ReadonlySet<RemotePrStatusKind> = new Set([
  'merged',
  'ready',
  'blocked',
  'running',
  'failed',
]);

/** Phones open this link, so only https pull request pages pass; enterprise hosts can have any name. */
function isPrUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 500) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      /^\/[\w.-]+\/[\w.-]+\/pull\/\d+(?:\/|$)/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/** The renderer's PR row for a task, or undefined unless it names a GitHub pull request. */
export function sanitizeRemotePr(value: unknown): RemoteTaskPr | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const pr = value as Record<string, unknown>;
  if (!isPrUrl(pr.url)) return undefined;
  return {
    url: pr.url,
    ...(typeof pr.label === 'string' && pr.label && { label: pr.label.slice(0, 80) }),
    ...(PR_KINDS.has(pr.kind as RemotePrStatusKind) && { kind: pr.kind as RemotePrStatusKind }),
    ...(pr.babysit === true && { babysit: true }),
  };
}
