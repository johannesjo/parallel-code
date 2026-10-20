import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  codexHome,
  fetchCodexUsage,
  parseCodexAuth,
  parseCodexUsageResponse,
} from './codex-usage.js';

const NOW = 1_700_000_000_000;
const CHATGPT_AUTH = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: { access_token: 'secret-token', account_id: 'acct-1' },
});

describe('parseCodexAuth', () => {
  it('extracts the ChatGPT access token and account id', () => {
    expect(parseCodexAuth(CHATGPT_AUTH)).toEqual({
      accessToken: 'secret-token',
      accountId: 'acct-1',
    });
  });

  it('tolerates a login that predates the persisted account id', () => {
    expect(parseCodexAuth('{"tokens":{"access_token":"tok"}}')).toEqual({
      accessToken: 'tok',
      accountId: null,
    });
  });

  it('ignores API-key logins and documents without a token', () => {
    expect(parseCodexAuth('{"auth_mode":"apikey","tokens":{"access_token":"tok"}}')).toBeNull();
    expect(parseCodexAuth('{"auth_mode":"apikey","OPENAI_API_KEY":"sk","tokens":null}')).toBeNull();
    expect(parseCodexAuth('{"tokens":{"access_token":""}}')).toBeNull();
    expect(parseCodexAuth('{}')).toBeNull();
    expect(parseCodexAuth('null')).toBeNull();
    expect(parseCodexAuth('not json')).toBeNull();
  });
});

describe('parseCodexUsageResponse', () => {
  it('maps the primary window to five hours and the secondary to seven days', () => {
    const result = parseCodexUsageResponse(
      {
        plan_type: 'plus',
        rate_limit: {
          allowed: true,
          primary_window: {
            used_percent: 12,
            limit_window_seconds: 18_000,
            reset_after_seconds: 100,
            reset_at: 1_738_425_600,
          },
          secondary_window: { used_percent: 140, reset_at: 1_738_900_000 },
        },
      },
      NOW,
    );
    expect(result).toEqual({
      status: 'ok',
      fiveHour: { usedPercent: 12, resetsAt: 1_738_425_600_000 },
      sevenDay: { usedPercent: 100, resetsAt: 1_738_900_000_000 },
      fetchedAt: NOW,
    });
  });

  it('derives the reset time from reset_after_seconds when reset_at is missing', () => {
    const result = parseCodexUsageResponse(
      { rate_limit: { primary_window: { used_percent: 5, reset_after_seconds: 90 } } },
      NOW,
    );
    expect(result).toEqual({
      status: 'ok',
      fiveHour: { usedPercent: 5, resetsAt: NOW + 90_000 },
      sevenDay: null,
      fetchedAt: NOW,
    });
  });

  it('returns null without a rate-limit block or percentages', () => {
    expect(parseCodexUsageResponse({})).toBeNull();
    expect(parseCodexUsageResponse({ rate_limit: null })).toBeNull();
    expect(parseCodexUsageResponse({ rate_limit: { primary_window: { reset_at: 1 } } })).toBeNull();
    expect(parseCodexUsageResponse(null)).toBeNull();
    expect(parseCodexUsageResponse('nope')).toBeNull();
  });
});

describe('codexHome', () => {
  it('honours CODEX_HOME and falls back to ~/.codex', () => {
    expect(codexHome({ CODEX_HOME: '/custom/codex' })).toBe('/custom/codex');
    expect(codexHome({})).toBe(path.join(os.homedir(), '.codex'));
  });
});

describe('fetchCodexUsage', () => {
  const dirs: string[] = [];

  function home(auth?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
    dirs.push(dir);
    if (auth !== undefined) fs.writeFileSync(path.join(dir, 'auth.json'), auth);
    return dir;
  }

  function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return init.headers as Record<string, string>;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is unavailable without an auth file', async () => {
    const fetchMock = stubFetch(200, {});
    const result = await fetchCodexUsage(home());
    expect(result.status).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is unavailable for API-key logins', async () => {
    const fetchMock = stubFetch(200, {});
    const result = await fetchCodexUsage(home('{"auth_mode":"apikey","tokens":null}'));
    expect(result.status).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the bearer token and account id and returns parsed windows', async () => {
    const fetchMock = stubFetch(200, {
      rate_limit: { primary_window: { used_percent: 42, reset_at: 1_738_425_600 } },
    });
    const result = await fetchCodexUsage(home(CHATGPT_AUTH));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.fiveHour?.usedPercent).toBe(42);
    expect(sentHeaders(fetchMock)).toEqual({
      Authorization: 'Bearer secret-token',
      'ChatGPT-Account-Id': 'acct-1',
    });
  });

  it('omits the account header when the login has none', async () => {
    const fetchMock = stubFetch(200, {
      rate_limit: { secondary_window: { used_percent: 1, reset_at: 1 } },
    });
    await fetchCodexUsage(home('{"tokens":{"access_token":"tok"}}'));
    expect(sentHeaders(fetchMock)).toEqual({ Authorization: 'Bearer tok' });
  });

  it('reports rejected tokens as a recoverable error, not unavailable', async () => {
    stubFetch(401, { detail: 'expired' });
    const result = await fetchCodexUsage(home(CHATGPT_AUTH));
    expect(result.status).toBe('error');
    if (result.status === 'error')
      expect(result.message).toMatch(/Codex login token rejected \(HTTP 401\)/);
  });
});
