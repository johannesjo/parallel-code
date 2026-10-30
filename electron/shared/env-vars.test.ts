import { describe, expect, it } from 'vitest';
import { isValidEnvKey, sanitizeEnvVars } from './env-vars.js';

describe('isValidEnvKey', () => {
  it.each(['CLAUDE_CONFIG_DIR', '_PRIVATE', 'a1'])('accepts %s', (key) => {
    expect(isValidEnvKey(key)).toBe(true);
  });

  it.each(['', '1ABC', 'MY-VAR', 'A B', 'A=B', 'X;rm', '$HOME', 'ÄBC'])('rejects %j', (key) => {
    expect(isValidEnvKey(key)).toBe(false);
  });
});

describe('sanitizeEnvVars', () => {
  it('keeps valid string entries in order', () => {
    expect(sanitizeEnvVars({ B: '2', A: '1' })).toEqual({ B: '2', A: '1' });
    expect(Object.keys(sanitizeEnvVars({ B: '2', A: '1' }) ?? {})).toEqual(['B', 'A']);
  });

  it('drops invalid keys and non-string values', () => {
    expect(sanitizeEnvVars({ OK: 'x', 'BAD-KEY': 'y', NUM: 3, NIL: null })).toEqual({ OK: 'x' });
  });

  it.each([undefined, null, 'A=1', ['A'], {}, { 'BAD KEY': 'x' }])(
    'returns undefined when nothing usable remains (%j)',
    (raw) => {
      expect(sanitizeEnvVars(raw)).toBeUndefined();
    },
  );
});
