import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  antigravityFallbackCachePaths,
  antigravityQuotaCachePath,
  clearRememberedCredentials,
  discoverAllLanguageServerCredentials,
  discoverLanguageServerCredentials,
  fetchAntigravityUsage,
  parseAntigravityUsageResponse,
  parseQuotaWindow,
} from './antigravity-usage.js';

const NOW = 1_700_000_000_000;

beforeEach(() => {
  clearRememberedCredentials();
});

describe('antigravityQuotaCachePath', () => {
  it('honours ANTIGRAVITY_QUOTA_CACHE when set', () => {
    expect(antigravityQuotaCachePath({ ANTIGRAVITY_QUOTA_CACHE: '/custom/quota.json' })).toBe(
      '/custom/quota.json',
    );
  });

  it('honours XDG_CACHE_HOME and falls back to ~/.cache', () => {
    expect(antigravityQuotaCachePath({ XDG_CACHE_HOME: '/custom/cache' })).toBe(
      '/custom/cache/agy-hud/quota_cache.json',
    );
    expect(antigravityQuotaCachePath({})).toBe(
      path.join(os.homedir(), '.cache', 'agy-hud', 'quota_cache.json'),
    );
  });
});

describe('antigravityFallbackCachePaths', () => {
  it('returns fallback path under .gemini', () => {
    const paths = antigravityFallbackCachePaths({ HOME: '/home/tester' });
    expect(paths).toContain(
      path.join(
        '/home/tester',
        '.gemini',
        'antigravity-cli',
        'scratch',
        'agy-hud',
        'quota_cache.json',
      ),
    );
  });
});

describe('parseQuotaWindow', () => {
  it('parses direct usedPercent and resetsAt', () => {
    expect(parseQuotaWindow({ usedPercent: 45, resetsAt: 1_738_425_600_000 })).toEqual({
      usedPercent: 45,
      resetsAt: 1_738_425_600_000,
    });
  });

  it('converts remainingFraction to usedPercent', () => {
    expect(
      parseQuotaWindow({ remainingFraction: 0.61, resetTime: '2026-09-29T03:40:56Z' }),
    ).toEqual({
      usedPercent: 39,
      resetsAt: Date.parse('2026-09-29T03:40:56Z'),
    });
  });

  it('handles reset_in_seconds', () => {
    expect(parseQuotaWindow({ remaining_fraction: 0.25, reset_in_seconds: 120 }, NOW)).toEqual({
      usedPercent: 75,
      resetsAt: NOW + 120_000,
    });
  });

  it('clamps usedPercent to 0-100', () => {
    expect(parseQuotaWindow({ usedPercent: 120 })).toEqual({
      usedPercent: 100,
      resetsAt: null,
    });
    expect(parseQuotaWindow({ remainingFraction: -0.5 })).toEqual({
      usedPercent: 100,
      resetsAt: null,
    });
    expect(parseQuotaWindow({ remainingFraction: 1.5 })).toEqual({
      usedPercent: 0,
      resetsAt: null,
    });
  });

  it('returns null on invalid shapes', () => {
    expect(parseQuotaWindow(null)).toBeNull();
    expect(parseQuotaWindow({})).toBeNull();
    expect(parseQuotaWindow('nope')).toBeNull();
  });
});

describe('parseAntigravityUsageResponse', () => {
  it('parses models map and prioritizes the most consumed Gemini model', () => {
    const response = {
      timestamp: '2026-09-28T20:00:00Z',
      plan_name: 'Pro',
      models: {
        'Gemini 3.8 Flash (Low)': { remainingFraction: 0.8, resetTime: '2026-09-29T03:00:00Z' },
        'Gemini 3.8 Flash (High)': { remainingFraction: 0.5, resetTime: '2026-09-29T03:00:00Z' },
        'Claude Sonnet 4.6 (Thinking)': {
          remainingFraction: 0.1,
          resetTime: '2026-09-29T04:00:00Z',
        },
      },
    };
    const result = parseAntigravityUsageResponse(response, NOW);
    expect(result).toEqual({
      status: 'ok',
      fiveHour: {
        usedPercent: 50,
        resetsAt: Date.parse('2026-09-29T03:00:00Z'),
      },
      sevenDay: null,
      fetchedAt: Date.parse('2026-09-28T20:00:00Z'),
    });
  });

  it('parses LanguageServer clientModelConfigs from userStatus', () => {
    const response = {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            {
              label: 'Gemini 3.8 Flash (High)',
              quotaInfo: { remainingFraction: 0.6, resetTime: '2026-09-29T03:00:00Z' },
            },
          ],
        },
      },
    };
    const result = parseAntigravityUsageResponse(response, NOW);
    expect(result).toEqual({
      status: 'ok',
      fiveHour: {
        usedPercent: 40,
        resetsAt: Date.parse('2026-09-29T03:00:00Z'),
      },
      sevenDay: null,
      fetchedAt: NOW,
    });
  });

  it('parses official 5h and weekly bucket format', () => {
    const response = {
      'gemini-5h': { remaining_fraction: 0.4, reset_in_seconds: 3600 },
      'gemini-weekly': { remaining_fraction: 0.9, reset_in_seconds: 86400 },
    };
    const result = parseAntigravityUsageResponse(response, NOW);
    expect(result).toEqual({
      status: 'ok',
      fiveHour: { usedPercent: 60, resetsAt: NOW + 3_600_000 },
      sevenDay: { usedPercent: 10, resetsAt: NOW + 86_400_000 },
      fetchedAt: NOW,
    });
  });

  it('parses direct fiveHour and sevenDay objects', () => {
    const response = {
      fiveHour: { usedPercent: 30, resetsAt: 1_738_425_600_000 },
      sevenDay: { usedPercent: 5, resetsAt: 1_738_900_000_000 },
      fetchedAt: 9999,
    };
    const result = parseAntigravityUsageResponse(response, NOW);
    expect(result).toEqual({
      status: 'ok',
      fiveHour: { usedPercent: 30, resetsAt: 1_738_425_600_000 },
      sevenDay: { usedPercent: 5, resetsAt: 1_738_900_000_000 },
      fetchedAt: 9999,
    });
  });

  it('parses nested quota object from statusline payload', () => {
    const response = {
      product: 'antigravity',
      quota: {
        'gemini-5h': { remaining_fraction: 0.35, reset_time: '2026-09-29T03:40:56Z' },
        'gemini-weekly': { remaining_fraction: 0.45, reset_time: '2026-10-01T02:57:22Z' },
      },
    };
    const result = parseAntigravityUsageResponse(response, NOW);
    expect(result).toEqual({
      status: 'ok',
      fiveHour: { usedPercent: 65, resetsAt: Date.parse('2026-09-29T03:40:56Z') },
      sevenDay: { usedPercent: 55, resetsAt: Date.parse('2026-10-01T02:57:22Z') },
      fetchedAt: NOW,
    });
  });

  it('returns null when no windows can be derived', () => {
    expect(parseAntigravityUsageResponse({})).toBeNull();
    expect(parseAntigravityUsageResponse({ models: {} })).toBeNull();
    expect(parseAntigravityUsageResponse(null)).toBeNull();
  });
});

describe('fetchAntigravityUsage', () => {
  const dirs: string[] = [];

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-usage-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is unavailable when cache file does not exist and no env vars set', async () => {
    const missing = path.join(tempDir(), 'quota_cache.json');
    const result = await fetchAntigravityUsage(missing, {});
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toContain('No Antigravity quota found');
    }
  });

  it('reports error when cache file has invalid JSON', async () => {
    const dir = tempDir();
    const cacheFile = path.join(dir, 'quota_cache.json');
    fs.writeFileSync(cacheFile, '{ not valid json');
    const result = await fetchAntigravityUsage(cacheFile, {});
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('invalid JSON');
    }
  });

  it('reads and parses valid quota cache file', async () => {
    const dir = tempDir();
    const cacheFile = path.join(dir, 'quota_cache.json');
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        timestamp: '2026-09-28T22:00:00Z',
        models: {
          'Gemini 3.8 Flash (High)': {
            remainingFraction: 0.75,
            resetTime: '2026-09-29T03:00:00Z',
          },
        },
      }),
    );
    const result = await fetchAntigravityUsage(cacheFile, {});
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.fiveHour?.usedPercent).toBe(25);
      expect(result.fiveHour?.resetsAt).toBe(Date.parse('2026-09-29T03:00:00Z'));
    }
  });

  it('queries language server via loopback when credentials are provided in env', async () => {
    const http = await import('node:http');
    let receivedToken: string | undefined;

    const server = http.createServer((req, res) => {
      receivedToken = req.headers['x-codeium-csrf-token'] as string | undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                {
                  label: 'Gemini 3.1 Pro (High)',
                  quotaInfo: { remainingFraction: 0.5, resetTime: '2026-09-29T03:40:56Z' },
                },
              ],
            },
          },
        }),
      );
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const dir = tempDir();
      const cachePath = path.join(dir, 'quota_cache.json');
      const result = await fetchAntigravityUsage(cachePath, {
        ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`,
        ANTIGRAVITY_CSRF_TOKEN: 'test-csrf-123',
      });

      expect(receivedToken).toBe('test-csrf-123');
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.fiveHour?.usedPercent).toBe(50);
        expect(result.sevenDay).toBeNull();
      }
      expect(fs.existsSync(cachePath)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Layout agy-hud writes to ~/.cache/agy-hud/quota_cache.json.
  const agyHudCache = {
    timestamp: '2026-09-29T01:28:29.778Z',
    plan_name: 'Google AI Pro',
    '3p-5h': { remaining_fraction: 1, reset_time: '2026-09-29T05:11:15Z' },
    '3p-weekly': { remaining_fraction: 1, reset_time: '2026-10-06T00:11:15Z' },
    'gemini-5h': { remaining_fraction: 0, reset_time: '2026-09-29T03:40:56Z' },
    'gemini-weekly': { remaining_fraction: 0.25, reset_time: '2026-10-01T02:57:22Z' },
    models: {
      'Gemini 3.1 Pro (High)': { remainingFraction: 0, resetTime: '2026-09-29T03:40:56Z' },
    },
  };

  it('reads the weekly window from the agy-hud cache', async () => {
    const cacheFile = path.join(tempDir(), 'quota_cache.json');
    fs.writeFileSync(cacheFile, JSON.stringify(agyHudCache));
    const result = await fetchAntigravityUsage(cacheFile, {});
    expect(result).toMatchObject({
      status: 'ok',
      fiveHour: { usedPercent: 100, resetsAt: Date.parse('2026-09-29T03:40:56Z') },
      sevenDay: { usedPercent: 75, resetsAt: Date.parse('2026-10-01T02:57:22Z') },
    });
  });

  it('dates an untimestamped statusline payload by when the file was written', async () => {
    const cacheFile = path.join(tempDir(), 'quota_cache.json');
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        quota: { 'gemini-weekly': { remaining_fraction: 0.03, reset_in_seconds: 3600 } },
      }),
    );
    const writtenAt = new Date('2026-09-29T23:04:38Z');
    fs.utimesSync(cacheFile, writtenAt, writtenAt);
    const result = await fetchAntigravityUsage(cacheFile, {});
    expect(result).toMatchObject({
      status: 'ok',
      sevenDay: { usedPercent: 97, resetsAt: writtenAt.getTime() + 3_600_000 },
      fetchedAt: writtenAt.getTime(),
    });
  });

  it('fills the weekly window from the cache when the language server has none', async () => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                {
                  label: 'Gemini 3.1 Pro (High)',
                  quotaInfo: { remainingFraction: 0.5, resetTime: '2026-09-29T03:40:56Z' },
                },
              ],
            },
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const cacheFile = path.join(tempDir(), 'quota_cache.json');
      const cacheJson = JSON.stringify(agyHudCache);
      fs.writeFileSync(cacheFile, cacheJson);
      const result = await fetchAntigravityUsage(cacheFile, {
        ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`,
        ANTIGRAVITY_CSRF_TOKEN: 'test-csrf-123',
      });

      expect(result).toMatchObject({
        status: 'ok',
        fiveHour: { usedPercent: 50 },
        sevenDay: { usedPercent: 75 },
      });
      // The cache belongs to agy-hud; a live read must not drop its weekly buckets.
      expect(fs.readFileSync(cacheFile, 'utf8')).toBe(cacheJson);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not overwrite the five-hour cache window when language server reports weekly quota for Gemini', async () => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                {
                  label: 'Gemini 3.8 Flash (High)',
                  quotaInfo: { remainingFraction: 0.15, resetTime: '2026-10-01T02:57:22Z' },
                },
              ],
            },
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const cacheFile = path.join(tempDir(), 'quota_cache.json');
      fs.writeFileSync(cacheFile, JSON.stringify(agyHudCache));
      const result = await fetchAntigravityUsage(cacheFile, {
        ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`,
        ANTIGRAVITY_CSRF_TOKEN: 'test-csrf-123',
      });

      expect(result).toMatchObject({
        status: 'ok',
        fiveHour: { usedPercent: 100, resetsAt: Date.parse('2026-09-29T03:40:56Z') },
        sevenDay: { usedPercent: 85, resetsAt: Date.parse('2026-10-01T02:57:22Z') },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('uses discoverCredentials when provided', async () => {
    const mockDiscover = vi.fn().mockReturnValue(null);
    const missing = path.join(tempDir(), 'quota_cache.json');
    const result = await fetchAntigravityUsage(missing, {}, mockDiscover);
    expect(mockDiscover).toHaveBeenCalled();
    expect(result.status).toBe('unavailable');
  });

  it('tries candidate credentials in order until an active language server responds', async () => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                {
                  label: 'Gemini 3.8 Flash (High)',
                  quotaInfo: { remainingFraction: 0.7, resetTime: '2026-09-29T03:00:00Z' },
                },
              ],
            },
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const mockDiscover = vi.fn().mockReturnValue([
        { address: '127.0.0.1:1', token: 'dead-token' },
        { address: `127.0.0.1:${port}`, token: 'live-token' },
      ]);
      const missing = path.join(tempDir(), 'quota_cache.json');
      const result = await fetchAntigravityUsage(missing, {}, mockDiscover);

      expect(result).toMatchObject({
        status: 'ok',
        fiveHour: { usedPercent: 30 },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('discoverAllLanguageServerCredentials returns empty array when /proc does not exist', () => {
    const origPlatform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      expect(discoverAllLanguageServerCredentials()).toEqual([]);
      expect(discoverLanguageServerCredentials()).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('remembers active language server credentials for subsequent queries when discovery returns empty', async () => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                {
                  label: 'Gemini 3.8 Flash (High)',
                  quotaInfo: { remainingFraction: 0.8, resetTime: '2026-09-29T03:00:00Z' },
                },
              ],
            },
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const liveCred = { address: `127.0.0.1:${port}`, token: 'live-token' };
      const missing = path.join(tempDir(), 'quota_cache.json');
      const isolatedEnv = { HOME: tempDir() };

      // First query discovers and remembers credentials
      const first = await fetchAntigravityUsage(missing, isolatedEnv, () => [liveCred]);
      expect(first.status).toBe('ok');

      // Second query with empty discovery reuses the remembered credentials
      const second = await fetchAntigravityUsage(missing, isolatedEnv, () => []);
      expect(second.status).toBe('ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('prunes dead remembered credentials when querying fails', async () => {
    const missing = path.join(tempDir(), 'quota_cache.json');
    const isolatedEnv = { HOME: tempDir() };
    // First query with dead port remembers nothing because query fails
    const deadCred = { address: '127.0.0.1:1', token: 'dead-token' };
    const first = await fetchAntigravityUsage(missing, isolatedEnv, () => [deadCred]);
    expect(first.status).toBe('unavailable');

    // Second query with empty discovery finds no candidates
    const second = await fetchAntigravityUsage(missing, isolatedEnv, () => []);
    expect(second.status).toBe('unavailable');
  });
});
