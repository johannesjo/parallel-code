import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { UsageResult, UsageWindow } from './shared-types.js';
import { warn as logWarn, errMessage } from '../log.js';
import { clampPercent, finite, parseResetsAt, requestUsage } from './usage-shared.js';

/**
 * Reads the rate-limit windows Claude Code shows under `/usage`, from the same
 * OAuth endpoint the CLI calls. Only subscription logins (Pro/Max) carry these
 * windows; API-key users get `unavailable` and the status bar stays hidden.
 * The endpoint is undocumented, so the parser tolerates both field spellings
 * seen in the wild (`utilization` and `used_percentage`).
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// macOS Claude Code keeps credentials in the login keychain, not on disk.
// Since 2.1 the service name is suffixed with a hash of a custom config dir.
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

const execFileAsync = promisify(execFile);

/** Shape of `execFile` the keychain reader needs; injectable so tests can run the darwin path on Linux. */
export type KeychainExec = (
  file: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string }>;

interface UsageWindowJson {
  utilization?: unknown;
  used_percentage?: unknown;
  resets_at?: unknown;
}

function parseWindow(value: unknown): UsageWindow | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as UsageWindowJson;
  const usedPercent = finite(raw.utilization) ?? finite(raw.used_percentage);
  if (usedPercent === null) return null;
  return { usedPercent: clampPercent(usedPercent), resetsAt: parseResetsAt(raw.resets_at) };
}

/** Parses the usage endpoint body. Returns null when neither window is present. */
export function parseClaudeUsageResponse(body: unknown, now = Date.now()): UsageResult | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as { five_hour?: unknown; seven_day?: unknown };
  const fiveHour = parseWindow(raw.five_hour);
  const sevenDay = parseWindow(raw.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { status: 'ok', fiveHour, sevenDay, fetchedAt: now };
}

/** Extracts the OAuth access token from a Claude credentials JSON document. */
export function parseAccessToken(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = parsed?.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function keychainServices(configDir: string): string[] {
  if (configDir === path.join(os.homedir(), '.claude')) return [KEYCHAIN_SERVICE];
  const suffix = crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return [`${KEYCHAIN_SERVICE}-${suffix}`, KEYCHAIN_SERVICE];
}

export async function readKeychainCredentials(
  configDir: string,
  exec: KeychainExec = execFileAsync,
): Promise<string | null> {
  for (const service of keychainServices(configDir)) {
    try {
      const { stdout } = await exec('security', ['find-generic-password', '-s', service, '-w'], {
        timeout: 5_000,
      });
      if (stdout.trim()) return stdout.trim();
    } catch {
      // `security` exits non-zero when the item is absent; try the next service name.
    }
  }
  return null;
}

async function readCredentialsFile(configDir: string): Promise<string | null> {
  const file = path.join(configDir, '.credentials.json');
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    // Missing file just means no subscription login; anything else is worth a trace.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logWarn('claude-usage', 'credentials file unreadable', { file, err: errMessage(err) });
    }
    return null;
  }
}

async function readCredentialsJson(configDir: string): Promise<string | null> {
  // macOS Claude Code keeps the live token in the keychain; a leftover file
  // there could hold a stale one, so the keychain wins when it has an entry.
  if (process.platform === 'darwin') {
    const fromKeychain = await readKeychainCredentials(configDir);
    if (fromKeychain) return fromKeychain;
  }
  return readCredentialsFile(configDir);
}

export async function fetchClaudeUsage(configDir = claudeConfigDir()): Promise<UsageResult> {
  const json = await readCredentialsJson(configDir);
  const token = json ? parseAccessToken(json) : null;
  if (!token) return { status: 'unavailable', reason: 'No Claude subscription login found' };
  return requestUsage({
    scope: 'claude-usage',
    agent: 'Claude Code',
    url: USAGE_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      // Only the CLI talks to this endpoint; present as it does so we get the same response.
      'User-Agent': 'claude-code/2.1.0',
    },
    parse: parseClaudeUsageResponse,
  });
}
