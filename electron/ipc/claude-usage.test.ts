import { afterEach, describe, expect, it } from 'vitest';
import {
  fetchClaudeUsage,
  parseClaudeStatusLine,
  recordClaudeStatusLine,
  resetClaudeUsage,
} from './claude-usage.js';

const NOW = 1_800_000_000_000;
const IN_AN_HOUR = NOW / 1000 + 3600;

function payload(rateLimits: unknown): unknown {
  return { session_id: 's', model: { id: 'm' }, rate_limits: rateLimits };
}

describe('parseClaudeStatusLine', () => {
  it('reads both windows in epoch seconds and clamps percentages', () => {
    expect(
      parseClaudeStatusLine(
        payload({
          five_hour: { used_percentage: 42.5, resets_at: IN_AN_HOUR },
          seven_day: { used_percentage: 120, resets_at: IN_AN_HOUR + 60 },
        }),
        NOW,
      ),
    ).toEqual({
      status: 'ok',
      fiveHour: { usedPercent: 42.5, resetsAt: IN_AN_HOUR * 1000 },
      sevenDay: { usedPercent: 100, resetsAt: (IN_AN_HOUR + 60) * 1000 },
      fetchedAt: NOW,
    });
  });

  it('keeps a window that arrives alone', () => {
    const parsed = parseClaudeStatusLine(payload({ seven_day: { used_percentage: 3 } }), NOW);
    expect(parsed).toMatchObject({
      fiveHour: null,
      sevenDay: { usedPercent: 3, resetsAt: null },
    });
  });

  it('reads a gateway spend limit once its dollar figures arrive', () => {
    expect(
      parseClaudeStatusLine(
        payload({ spend_limit: { used_percentage: 63, used_usd: 314.12, limit_usd: 500 } }),
        NOW,
      ),
    ).toMatchObject({
      creditUsage: { used: 314.12, limit: 500, currency: 'USD', usedPercent: 63 },
    });
    expect(parseClaudeStatusLine(payload({ spend_limit: { used_percentage: 63 } }), NOW)).toBe(
      null,
    );
  });

  it('returns null without rate limits, as for an API-key session', () => {
    expect(parseClaudeStatusLine({ session_id: 's' }, NOW)).toBeNull();
    expect(parseClaudeStatusLine(payload({}), NOW)).toBeNull();
    expect(parseClaudeStatusLine(payload('nope'), NOW)).toBeNull();
    expect(parseClaudeStatusLine(null, NOW)).toBeNull();
  });
});

describe('fetchClaudeUsage', () => {
  afterEach(() => resetClaudeUsage());

  it('is unavailable until a session reports, then serves the last report', () => {
    expect(fetchClaudeUsage(NOW).status).toBe('unavailable');
    recordClaudeStatusLine(
      payload({ five_hour: { used_percentage: 10, resets_at: IN_AN_HOUR } }),
      NOW,
    );
    expect(fetchClaudeUsage(NOW + 1000)).toEqual({
      status: 'ok',
      fiveHour: { usedPercent: 10, resetsAt: IN_AN_HOUR * 1000 },
      sevenDay: null,
      fetchedAt: NOW,
    });
  });

  it('drops windows whose reset has passed', () => {
    recordClaudeStatusLine(
      payload({
        five_hour: { used_percentage: 10, resets_at: IN_AN_HOUR },
        seven_day: { used_percentage: 20, resets_at: IN_AN_HOUR + 86_400 },
      }),
      NOW,
    );
    const later = (IN_AN_HOUR + 1) * 1000;
    expect(fetchClaudeUsage(later)).toMatchObject({
      fiveHour: null,
      sevenDay: { usedPercent: 20 },
    });
    expect(fetchClaudeUsage((IN_AN_HOUR + 86_401) * 1000).status).toBe('unavailable');
  });

  it('reports a change only when the numbers move', () => {
    const report = payload({ five_hour: { used_percentage: 10, resets_at: IN_AN_HOUR } });
    expect(recordClaudeStatusLine(report, NOW)).toBe(true);
    expect(recordClaudeStatusLine(report, NOW + 300)).toBe(false);
    expect(
      recordClaudeStatusLine(
        payload({ five_hour: { used_percentage: 11, resets_at: IN_AN_HOUR } }),
        NOW + 600,
      ),
    ).toBe(true);
    expect(recordClaudeStatusLine({ session_id: 's' }, NOW + 900)).toBe(false);
    expect(fetchClaudeUsage(NOW + 1000)).toMatchObject({ fiveHour: { usedPercent: 11 } });
  });
});
