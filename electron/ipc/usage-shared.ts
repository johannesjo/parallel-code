import type { UsageResult } from './shared-types.js';
import { debug as logDebug, errMessage } from '../log.js';

/** Parsing and transport shared by the per-agent usage readers (claude-usage, codex-usage). */

const REQUEST_TIMEOUT_MS = 10_000;

export function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Reset times have shipped as ISO strings, epoch seconds and epoch ms; accept all three. */
export function parseResetsAt(value: unknown): number | null {
  const num = finite(value);
  // 1e10 separates any seconds epoch (< year 2286) from any ms epoch (> 2001).
  if (num !== null) return num > 1e10 ? num : num * 1000;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export interface UsageRequest {
  /** Log scope, e.g. `claude-usage`. */
  scope: string;
  /** Agent name for the rejected-token message, e.g. `Claude Code`. */
  agent: string;
  url: string;
  headers: Record<string, string>;
  /** Turns the endpoint body into windows; null when it carries none. */
  parse: (body: unknown) => UsageResult | null;
}

/**
 * GETs a usage endpoint with the agent's login token and maps the outcome to a
 * `UsageResult`. A rejected token is an `error` rather than `unavailable` so the
 * bar keeps its last snapshot and tells the user how to refresh the login.
 * Never throws: network failures come back as `error` too.
 */
export async function requestUsage(req: UsageRequest): Promise<UsageResult> {
  try {
    const res = await fetch(req.url, {
      headers: req.headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return {
        status: 'error',
        message: `${req.agent} login token rejected (HTTP ${res.status}) — start a ${req.agent} session to refresh it`,
      };
    }
    if (!res.ok) return { status: 'error', message: `Usage endpoint returned HTTP ${res.status}` };
    const parsed = req.parse(await res.json());
    return parsed ?? { status: 'unavailable', reason: 'No rate-limit windows in response' };
  } catch (err) {
    // The renderer shows this in the bar's tooltip; at warn it would spam the
    // log every tick while offline.
    logDebug(req.scope, 'fetch failed', { err: errMessage(err) });
    return { status: 'error', message: errMessage(err) };
  }
}
