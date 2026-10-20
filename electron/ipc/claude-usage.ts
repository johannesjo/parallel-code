import type { CreditUsage, UsageResult, UsageWindow } from './shared-types.js';
import { clampPercent, finite, parseResetsAt } from './usage-shared.js';

/**
 * The rate-limit windows Claude Code shows under `/usage`, as the CLI itself
 * reports them to the status line command the app registers (`rate_limits` in
 * the status line's stdin JSON). The app never reads the Claude login or calls
 * Anthropic for them: the CLI sends the numbers only to Pro/Max logins (or
 * behind a gateway with a spend limit), and only after a session's first
 * response, so until a terminal Claude session has answered the bar stays hidden.
 */

interface RateWindowJson {
  used_percentage?: unknown;
  resets_at?: unknown;
}

interface SpendLimitJson extends RateWindowJson {
  used_usd?: unknown;
  limit_usd?: unknown;
}

let latest: Extract<UsageResult, { status: 'ok' }> | null = null;

function parseWindow(value: unknown): UsageWindow | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as RateWindowJson;
  const usedPercent = finite(raw.used_percentage);
  if (usedPercent === null) return null;
  return { usedPercent: clampPercent(usedPercent), resetsAt: parseResetsAt(raw.resets_at) };
}

/** A gateway spend limit, once the CLI has its dollar figures; the percentage alone arrives first. */
function parseSpendLimit(value: unknown): CreditUsage | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as SpendLimitJson;
  const used = finite(raw.used_usd);
  if (used === null) return null;
  const percent = finite(raw.used_percentage);
  return {
    used,
    limit: finite(raw.limit_usd),
    currency: 'USD',
    usedPercent: percent !== null ? clampPercent(percent) : null,
  };
}

/** Reads the `rate_limits` of a status line payload. Null when it carries none. */
export function parseClaudeStatusLine(body: unknown, now = Date.now()): UsageResult | null {
  if (typeof body !== 'object' || body === null) return null;
  const limits = (body as { rate_limits?: unknown }).rate_limits;
  if (typeof limits !== 'object' || limits === null) return null;
  const raw = limits as { five_hour?: unknown; seven_day?: unknown; spend_limit?: unknown };
  const fiveHour = parseWindow(raw.five_hour);
  const sevenDay = parseWindow(raw.seven_day);
  const creditUsage = parseSpendLimit(raw.spend_limit);
  if (!fiveHour && !sevenDay && !creditUsage) return null;
  return {
    status: 'ok',
    fiveHour,
    sevenDay,
    ...(creditUsage ? { creditUsage } : {}),
    fetchedAt: now,
  };
}

function sameWindow(a: UsageWindow | null, b: UsageWindow | null): boolean {
  return a?.usedPercent === b?.usedPercent && a?.resetsAt === b?.resetsAt;
}

function sameCredit(a: CreditUsage | null | undefined, b: CreditUsage | null | undefined): boolean {
  return (
    a?.used === b?.used &&
    a?.limit === b?.limit &&
    a?.currency === b?.currency &&
    a?.usedPercent === b?.usedPercent
  );
}

/**
 * Records a status line payload. Returns true when the windows changed, so the
 * caller tells the renderer only then: the status line re-runs on every update
 * of a streaming session, almost always with the same numbers.
 */
export function recordClaudeStatusLine(body: unknown, now = Date.now()): boolean {
  const parsed = parseClaudeStatusLine(body, now);
  if (parsed?.status !== 'ok') return false;
  const changed =
    !latest ||
    !sameWindow(latest.fiveHour, parsed.fiveHour) ||
    !sameWindow(latest.sevenDay, parsed.sevenDay) ||
    !sameCredit(latest.creditUsage, parsed.creditUsage);
  latest = parsed;
  return changed;
}

/** Forgets the last report. For tests. */
export function resetClaudeUsage(): void {
  latest = null;
}

function current(window: UsageWindow | null, now: number): UsageWindow | null {
  // The CLI drops a window once it resets, so a passed reset means a stale number.
  return window && window.resetsAt !== null && window.resetsAt <= now ? null : window;
}

/** The last windows a Claude Code session reported, minus any that have since reset. */
export function fetchClaudeUsage(now = Date.now()): UsageResult {
  if (!latest) {
    return { status: 'unavailable', reason: 'No Claude Code session has reported usage yet' };
  }
  const fiveHour = current(latest.fiveHour, now);
  const sevenDay = current(latest.sevenDay, now);
  if (!fiveHour && !sevenDay && !latest.creditUsage) {
    return { status: 'unavailable', reason: 'Claude Code usage windows have reset' };
  }
  return { ...latest, fiveHour, sevenDay };
}
