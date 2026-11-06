import { describe, expect, it } from 'vitest';
import { parseCloseSuggestion } from './close-suggestion.js';

describe('parseCloseSuggestion', () => {
  const at = '2026-11-06T10:00:00.000Z';

  it('keeps a well-formed suggestion and trims its reason', () => {
    expect(parseCloseSuggestion({ reason: '  Superseded by task B ', at })).toEqual({
      reason: 'Superseded by task B',
      at,
    });
  });

  it('drops malformed persisted values', () => {
    for (const raw of [
      undefined,
      null,
      'Superseded',
      { reason: 'Superseded' },
      { reason: '   ', at },
      { reason: 'x'.repeat(501), at },
      { reason: 'Superseded', at: 'yesterday' },
      { reason: 42, at },
    ])
      expect(parseCloseSuggestion(raw)).toBeUndefined();
  });
});
