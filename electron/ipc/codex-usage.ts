import fs from 'fs';
import os from 'os';
import path from 'path';
import type { UsageResult, UsageWindow } from './shared-types.js';
import { warn as logWarn, errMessage } from '../log.js';
import { clampPercent, finite, parseResetsAt, requestUsage } from './usage-shared.js';

/**
 * Reads the rate-limit windows Codex CLI shows under `/status`, from the same
 * ChatGPT backend endpoint the CLI calls. Only ChatGPT logins carry these
 * windows; API-key users get `unavailable` and the status bar stays hidden.
 * The endpoint is undocumented; the field names are the ones Codex 0.152 reads.
 */

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export interface CodexAuth {
  accessToken: string;
  /** Selects the ChatGPT workspace; older CLIs did not persist it. */
  accountId: string | null;
}

interface CodexAuthJson {
  auth_mode?: unknown;
  tokens?: { access_token?: unknown; account_id?: unknown } | null;
}

interface CodexWindowJson {
  used_percent?: unknown;
  reset_at?: unknown;
  reset_after_seconds?: unknown;
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Extracts the ChatGPT login from a Codex `auth.json`. API-key logins have no windows and yield null. */
export function parseCodexAuth(json: string): CodexAuth | null {
  let parsed: CodexAuthJson | null;
  try {
    parsed = JSON.parse(json) as CodexAuthJson | null;
  } catch {
    return null;
  }
  if (parsed?.auth_mode === 'apikey') return null;
  const token = parsed?.tokens?.access_token;
  if (typeof token !== 'string' || !token) return null;
  const accountId = parsed?.tokens?.account_id;
  return {
    accessToken: token,
    accountId: typeof accountId === 'string' && accountId ? accountId : null,
  };
}

function parseWindow(value: unknown, now: number): UsageWindow | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as CodexWindowJson;
  const usedPercent = finite(raw.used_percent);
  if (usedPercent === null) return null;
  const resetAfter = finite(raw.reset_after_seconds);
  const resetsAt =
    parseResetsAt(raw.reset_at) ?? (resetAfter === null ? null : now + resetAfter * 1000);
  return { usedPercent: clampPercent(usedPercent), resetsAt };
}

/** Parses the usage endpoint body. Returns null when neither window is present. */
export function parseCodexUsageResponse(body: unknown, now = Date.now()): UsageResult | null {
  if (typeof body !== 'object' || body === null) return null;
  const limit = (body as { rate_limit?: unknown }).rate_limit;
  if (typeof limit !== 'object' || limit === null) return null;
  const raw = limit as { primary_window?: unknown; secondary_window?: unknown };
  // Every ChatGPT plan ships the same pair: a five-hour primary window and a weekly secondary one.
  const fiveHour = parseWindow(raw.primary_window, now);
  const sevenDay = parseWindow(raw.secondary_window, now);
  if (!fiveHour && !sevenDay) return null;
  return { status: 'ok', fiveHour, sevenDay, fetchedAt: now };
}

async function readAuth(home: string): Promise<CodexAuth | null> {
  const file = path.join(home, 'auth.json');
  try {
    return parseCodexAuth(await fs.promises.readFile(file, 'utf8'));
  } catch (err) {
    // Missing file just means Codex was never logged in; anything else is worth a trace.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logWarn('codex-usage', 'auth file unreadable', { file, err: errMessage(err) });
    }
    return null;
  }
}

export async function fetchCodexUsage(home = codexHome()): Promise<UsageResult> {
  const auth = await readAuth(home);
  if (!auth) return { status: 'unavailable', reason: 'No Codex ChatGPT login found' };
  const headers: Record<string, string> = { Authorization: `Bearer ${auth.accessToken}` };
  if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId;
  return requestUsage({
    scope: 'codex-usage',
    agent: 'Codex',
    url: USAGE_URL,
    headers,
    parse: parseCodexUsageResponse,
  });
}
