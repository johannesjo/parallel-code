import { describe, expect, it } from 'vitest';
import {
  envDraftsError,
  envDraftsFrom,
  finalizeEnvDrafts,
  type EnvDraft,
} from './project-env-drafts';

const row = (key: string, value = 'v'): EnvDraft => ({ id: key + value, key, value });

describe('project env drafts', () => {
  it('round-trips a stored map', () => {
    const env = { CLAUDE_CONFIG_DIR: '~/.claude-work', TOKEN: 'secret' };
    expect(finalizeEnvDrafts(envDraftsFrom(env))).toEqual(env);
    expect(envDraftsFrom(undefined)).toEqual([]);
  });

  it('trims keys, keeps values verbatim and ignores blank rows', () => {
    const drafts = [row(' KEY ', ' spaced value '), row('', '')];
    expect(envDraftsError(drafts)).toBe('');
    expect(finalizeEnvDrafts(drafts)).toEqual({ KEY: ' spaced value ' });
  });

  it('stores nothing when every row is blank', () => {
    expect(finalizeEnvDrafts([row('', '')])).toBeUndefined();
  });

  it.each([
    [[row('MY-VAR')], '"MY-VAR" is not a valid name'],
    [[row('1ABC')], '"1ABC" is not a valid name'],
    [[row('', 'orphan')], 'Every value needs a variable name.'],
    [[row('A', '1'), row('A', '2')], '"A" is set more than once.'],
  ])('reports %j', (drafts, message) => {
    expect(envDraftsError(drafts)).toContain(message);
  });

  it('allows an empty value', () => {
    expect(envDraftsError([row('EMPTY', '')])).toBe('');
    expect(finalizeEnvDrafts([row('EMPTY', '')])).toEqual({ EMPTY: '' });
  });
});
