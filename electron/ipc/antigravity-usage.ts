import fs from 'fs';
import http from 'node:http';
import https from 'node:https';
import os from 'os';
import path from 'path';
import type { UsageResult, UsageWindow } from './shared-types.js';
import { warn as logWarn, debug as logDebug, errMessage } from '../log.js';
import { clampPercent, finite, parseResetsAt } from './usage-shared.js';

/**
 * Reads rate-limit windows for Google Antigravity CLI.
 *
 * Supports live loopback queries to the Antigravity language server service
 * (via HTTP/HTTPS and `X-Codeium-Csrf-Token`), active process discovery on Linux,
 * and reading local cache/statusline files (e.g. `quota_cache.json` or `statusline_payload.json`).
 */

export function antigravityQuotaCachePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ANTIGRAVITY_QUOTA_CACHE) return env.ANTIGRAVITY_QUOTA_CACHE;
  const cacheHome = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cacheHome, 'agy-hud', 'quota_cache.json');
}

export function antigravityFallbackCachePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const cacheHome =
    env.XDG_CACHE_HOME ||
    (env.HOME
      ? path.join(env.HOME, '.cache')
      : env === process.env
        ? path.join(os.homedir(), '.cache')
        : '');
  const home = env.HOME || (env === process.env ? os.homedir() : '');
  const paths: string[] = [];
  if (cacheHome) {
    paths.push(path.join(cacheHome, 'agy-hud', 'statusline_payload.json'));
    paths.push(path.join(cacheHome, 'agy-hud', 'quota_cache.json'));
  }
  if (home) {
    paths.push(
      path.join(
        home,
        '.gemini',
        'antigravity-cli',
        'scratch',
        'agy-hud',
        'statusline_payload.json',
      ),
    );
    paths.push(
      path.join(home, '.gemini', 'antigravity-cli', 'scratch', 'agy-hud', 'quota_cache.json'),
    );
    paths.push(path.join(home, '.gemini', 'antigravity-cli', 'statusline_payload.json'));
    paths.push(path.join(home, '.gemini', 'antigravity-cli', 'quota_cache.json'));
  }
  return paths;
}

interface RawQuotaWindow {
  remainingFraction?: unknown;
  remaining_fraction?: unknown;
  resetTime?: unknown;
  reset_time?: unknown;
  reset_after_seconds?: unknown;
  reset_in_seconds?: unknown;
  usedPercent?: unknown;
  used_percent?: unknown;
  resetsAt?: unknown;
  resets_at?: unknown;
}

export function parseQuotaWindow(value: unknown, now = Date.now()): UsageWindow | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as RawQuotaWindow;

  // Direct used percent
  const directUsed = finite(raw.usedPercent) ?? finite(raw.used_percent);
  if (directUsed !== null) {
    const rawReset = raw.resetsAt ?? raw.resets_at ?? raw.resetTime ?? raw.reset_time;
    const resetSeconds = finite(raw.reset_in_seconds) ?? finite(raw.reset_after_seconds);
    const resetsAt =
      parseResetsAt(rawReset) ?? (resetSeconds !== null ? now + resetSeconds * 1000 : null);
    return { usedPercent: clampPercent(directUsed), resetsAt };
  }

  // Remaining fraction (0.0 to 1.0)
  const remaining = finite(raw.remainingFraction) ?? finite(raw.remaining_fraction);
  if (remaining !== null) {
    const clampedRemaining = Math.max(0, Math.min(1, remaining));
    const usedPercent = clampPercent(Math.round((1 - clampedRemaining) * 100));
    const rawReset = raw.resetsAt ?? raw.resets_at ?? raw.resetTime ?? raw.reset_time;
    const resetSeconds = finite(raw.reset_in_seconds) ?? finite(raw.reset_after_seconds);
    const resetsAt =
      parseResetsAt(rawReset) ?? (resetSeconds !== null ? now + resetSeconds * 1000 : null);
    return { usedPercent, resetsAt };
  }

  return null;
}

function selectPrimaryModelWindow(
  models: Record<string, unknown>,
  now: number,
): UsageWindow | null {
  const entries = Object.entries(models);
  if (entries.length === 0) return null;

  const parsedModels: Array<{ label: string; window: UsageWindow }> = [];
  for (const [label, val] of entries) {
    const win = parseQuotaWindow(val, now);
    if (win) parsedModels.push({ label, window: win });
  }
  if (parsedModels.length === 0) return null;

  // Prioritize Gemini models first
  const geminiModels = parsedModels.filter((m) => /gemini/i.test(m.label));
  const pool = geminiModels.length > 0 ? geminiModels : parsedModels;

  // Pick the most constrained window (highest usedPercent)
  let best = pool[0];
  for (let i = 1; i < pool.length; i++) {
    if (pool[i].window.usedPercent > best.window.usedPercent) {
      best = pool[i];
    }
  }
  return best.window;
}

/** Parses Antigravity quota payload from cache, statusline, or local server. */
type UsageSnapshot = Extract<UsageResult, { status: 'ok' }>;

export function parseAntigravityUsageResponse(
  body: unknown,
  now = Date.now(),
): UsageSnapshot | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  const quotaObj =
    raw.quota && typeof raw.quota === 'object' ? (raw.quota as Record<string, unknown>) : raw;

  let fiveHour: UsageWindow | null = null;
  let sevenDay: UsageWindow | null = null;
  let fetchedAt = now;

  if (raw.timestamp) {
    const ts = parseResetsAt(raw.timestamp);
    if (ts !== null) fetchedAt = ts;
  } else if (finite(raw.fetchedAt)) {
    fetchedAt = raw.fetchedAt as number;
  }

  // Format 1: direct fiveHour / sevenDay
  if (
    raw.fiveHour ||
    raw.five_hour ||
    raw.sevenDay ||
    raw.seven_day ||
    quotaObj.fiveHour ||
    quotaObj.five_hour ||
    quotaObj.sevenDay ||
    quotaObj.seven_day
  ) {
    fiveHour = parseQuotaWindow(
      raw.fiveHour ?? raw.five_hour ?? quotaObj.fiveHour ?? quotaObj.five_hour,
      now,
    );
    sevenDay = parseQuotaWindow(
      raw.sevenDay ?? raw.seven_day ?? quotaObj.sevenDay ?? quotaObj.seven_day,
      now,
    );
  }

  // Format 2: official bucket format (e.g. gemini-5h, gemini-weekly, 3p-5h, 3p-weekly)
  const modelId =
    (typeof raw.model === 'object' &&
    raw.model !== null &&
    typeof (raw.model as Record<string, unknown>).id === 'string'
      ? ((raw.model as Record<string, unknown>).id as string)
      : '') || (typeof raw.model === 'string' ? raw.model : '');
  const is3pModel = /claude|gpt|oss/i.test(modelId);

  if (!fiveHour) {
    const first5h = is3pModel
      ? (raw['3p-5h'] ?? quotaObj['3p-5h'] ?? raw['gemini-5h'] ?? quotaObj['gemini-5h'])
      : (raw['gemini-5h'] ?? quotaObj['gemini-5h'] ?? raw['3p-5h'] ?? quotaObj['3p-5h']);
    if (first5h) {
      fiveHour = parseQuotaWindow(first5h, now);
    }
  }
  if (!sevenDay) {
    const firstWeekly = is3pModel
      ? (raw['3p-weekly'] ??
        quotaObj['3p-weekly'] ??
        raw['gemini-weekly'] ??
        quotaObj['gemini-weekly'] ??
        raw.weekly ??
        quotaObj.weekly)
      : (raw['gemini-weekly'] ??
        quotaObj['gemini-weekly'] ??
        raw['3p-weekly'] ??
        quotaObj['3p-weekly'] ??
        raw.weekly ??
        quotaObj.weekly);
    if (firstWeekly) {
      sevenDay = parseQuotaWindow(firstWeekly, now);
    }
  }

  // Format 3: language server userStatus payload: userStatus.cascadeModelConfigData.clientModelConfigs
  let modelsObj: Record<string, unknown> | null = null;
  if (raw.models && typeof raw.models === 'object') {
    modelsObj = raw.models as Record<string, unknown>;
  } else if (quotaObj.models && typeof quotaObj.models === 'object') {
    modelsObj = quotaObj.models as Record<string, unknown>;
  } else if (raw.userStatus && typeof raw.userStatus === 'object') {
    const userStatus = raw.userStatus as Record<string, unknown>;
    const cascade = userStatus.cascadeModelConfigData as Record<string, unknown> | undefined;
    const configs = cascade?.clientModelConfigs;
    if (Array.isArray(configs)) {
      modelsObj = {};
      for (const item of configs) {
        if (
          typeof item === 'object' &&
          item !== null &&
          typeof item.label === 'string' &&
          item.quotaInfo
        ) {
          modelsObj[item.label] = item.quotaInfo;
        }
      }
    }
  }

  // Extract from models if fiveHour not yet found
  if (!fiveHour && modelsObj) {
    fiveHour = selectPrimaryModelWindow(modelsObj, now);
  }

  if (!fiveHour && !sevenDay) return null;

  return {
    status: 'ok',
    fiveHour,
    sevenDay,
    fetchedAt,
  };
}

export async function queryAntigravityLanguageServer(
  address: string,
  csrfToken: string,
  timeoutMs = 2_000,
): Promise<unknown | null> {
  let initialProto = 'http:';
  let host = '127.0.0.1';
  let port = 0;

  if (address.startsWith('http://') || address.startsWith('https://')) {
    try {
      const url = new URL(address);
      initialProto = url.protocol;
      host = url.hostname;
      port = Number(url.port);
    } catch {
      return null;
    }
  } else {
    const [h, p] = address.split(':');
    host = h === 'localhost' ? '127.0.0.1' : h;
    port = Number(p);
  }

  if (!host || !port) return null;

  const tryRequest = (protocol: string): Promise<unknown | null> =>
    new Promise((resolve) => {
      const mod = protocol === 'https:' ? https : http;
      const req = mod.request(
        {
          protocol,
          hostname: host,
          port,
          path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'X-Codeium-Csrf-Token': csrfToken,
          },
          rejectUnauthorized: false,
          timeout: timeoutMs,
        },
        (res) => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            resolve(null);
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (chunk) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
          );
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              resolve(null);
            }
          });
        },
      );

      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
      req.write('{}');
      req.end();
    });

  let res = await tryRequest(initialProto);
  if (!res && initialProto === 'http:') {
    res = await tryRequest('https:');
  }
  return res;
}

const rememberedCredentials = new Map<string, { address: string; token: string }>();

export function clearRememberedCredentials(): void {
  rememberedCredentials.clear();
}

/** Discovers active Language Server address and CSRF token from running processes on Linux. */
export function discoverAllLanguageServerCredentials(): Array<{ address: string; token: string }> {
  if (process.platform !== 'linux') return [];
  const credentials: Array<{ address: string; token: string }> = [];
  const seenAddresses = new Set<string>();

  try {
    const entries = fs
      .readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number)
      .sort((a, b) => b - a);

    for (const pid of entries) {
      try {
        const envBuf = fs.readFileSync(`/proc/${pid}/environ`);
        if (envBuf.includes(Buffer.from('ANTIGRAVITY_CSRF_TOKEN='))) {
          const str = envBuf.toString('utf8');
          const addrMatch = str.match(/ANTIGRAVITY_LS_ADDRESS=([^\0]+)/);
          const csrfMatch = str.match(/ANTIGRAVITY_CSRF_TOKEN=([^\0]+)/);
          if (addrMatch && csrfMatch) {
            const address = addrMatch[1];
            const token = csrfMatch[1];
            if (!seenAddresses.has(address)) {
              seenAddresses.add(address);
              credentials.push({ address, token });
              rememberedCredentials.set(address, { address, token });
            }
          }
        }
      } catch {
        // Skip unreadable processes or processes that exit during iteration
      }
    }
  } catch {
    // /proc unreadable
  }
  return credentials;
}

export function discoverLanguageServerCredentials(): { address: string; token: string } | null {
  const all = discoverAllLanguageServerCredentials();
  return all.length > 0 ? all[0] : null;
}

export type DiscoverCredentialsFn = () =>
  | { address: string; token: string }
  | Array<{ address: string; token: string }>
  | null;

async function readQuotaCacheFile(
  primaryPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ json: string; mtimeMs: number } | null> {
  const isCustomPath = primaryPath !== antigravityQuotaCachePath(env);
  const candidates = isCustomPath
    ? [primaryPath]
    : [primaryPath, ...antigravityFallbackCachePaths(env)];
  const existingFiles: Array<{ filePath: string; mtimeMs: number }> = [];

  for (const filePath of candidates) {
    try {
      const stat = await fs.promises.stat(filePath);
      existingFiles.push({ filePath, mtimeMs: stat.mtimeMs });
    } catch {
      // File does not exist
    }
  }

  // Prioritize the newest file by mtime
  existingFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { filePath, mtimeMs } of existingFiles) {
    try {
      return { json: await fs.promises.readFile(filePath, 'utf8'), mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logWarn('antigravity-usage', 'quota cache unreadable', {
          file: filePath,
          err: errMessage(err),
        });
      }
    }
  }
  return null;
}

export async function fetchAntigravityUsage(
  cachePath = antigravityQuotaCachePath(),
  env = process.env,
  discoverCredentials?: DiscoverCredentialsFn,
): Promise<UsageResult> {
  const lsAddress = env.ANTIGRAVITY_LS_ADDRESS;
  const csrfToken = env.ANTIGRAVITY_CSRF_TOKEN;

  let candidateList: Array<{ address: string; token: string }> = [];

  if (lsAddress && csrfToken) {
    candidateList = [{ address: lsAddress, token: csrfToken }];
  } else if (discoverCredentials) {
    const discovered = discoverCredentials();
    const list = discovered ? (Array.isArray(discovered) ? discovered : [discovered]) : [];
    const seen = new Set<string>();
    candidateList = [];
    for (const cred of [...list, ...rememberedCredentials.values()]) {
      if (!seen.has(cred.address)) {
        seen.add(cred.address);
        candidateList.push(cred);
      }
    }
  } else if (env === process.env && !env.ANTIGRAVITY_DISABLE_DISCOVERY) {
    const fresh = discoverAllLanguageServerCredentials();
    const seen = new Set<string>();
    candidateList = [];
    for (const cred of [...fresh, ...rememberedCredentials.values()]) {
      if (!seen.has(cred.address)) {
        seen.add(cred.address);
        candidateList.push(cred);
      }
    }
  }

  // Query discovered candidates in order until an active language server responds
  let live: UsageSnapshot | null = null;
  for (const cred of candidateList) {
    live = await queryLiveUsage(cred);
    if (live) {
      rememberedCredentials.set(cred.address, cred);
      break;
    } else {
      rememberedCredentials.delete(cred.address);
    }
  }
  const cached = await readCachedUsage(cachePath, env);
  if (!live) return cached;
  if (cached.status !== 'ok') return live;

  // The Antigravity language server reports weekly quota for Gemini models in clientModelConfigs.
  // If the live parsed "fiveHour" window has the same reset timestamp as the weekly window,
  // it is actually the weekly window and must not overwrite the real five-hour window from cache.
  const isLiveWeekly =
    Boolean(live.fiveHour?.resetsAt) &&
    (live.fiveHour?.resetsAt === cached.sevenDay?.resetsAt ||
      live.fiveHour?.resetsAt === live.sevenDay?.resetsAt);

  const fiveHour = isLiveWeekly ? (cached.fiveHour ?? null) : (live.fiveHour ?? cached.fiveHour);
  const sevenDay = isLiveWeekly
    ? (live.fiveHour ?? cached.sevenDay)
    : (live.sevenDay ?? cached.sevenDay);

  return {
    ...live,
    fiveHour,
    sevenDay,
  };
}

async function queryLiveUsage(credentials: {
  address: string;
  token: string;
}): Promise<UsageSnapshot | null> {
  try {
    const serverResponse = await queryAntigravityLanguageServer(
      credentials.address,
      credentials.token,
    );
    return serverResponse ? parseAntigravityUsageResponse(serverResponse) : null;
  } catch (err) {
    logDebug('antigravity-usage', 'language server query failed, falling back to cache', {
      err: errMessage(err),
    });
    return null;
  }
}

async function readCachedUsage(cachePath: string, env: NodeJS.ProcessEnv): Promise<UsageResult> {
  const file = await readQuotaCacheFile(cachePath, env);
  if (!file) {
    return { status: 'unavailable', reason: 'No Antigravity quota found' };
  }

  let data: unknown;
  try {
    data = JSON.parse(file.json);
  } catch {
    return { status: 'error', message: 'Antigravity quota cache contains invalid JSON' };
  }

  // Antigravity only rewrites these files while a CLI session runs, and most payloads carry no
  // timestamp. Date the snapshot by the file's write time so a stale quota does not read as current
  // and relative reset times count from when they were written.
  const result = parseAntigravityUsageResponse(data, file.mtimeMs);
  if (!result) {
    return { status: 'unavailable', reason: 'No rate-limit windows in response' };
  }
  return result;
}
