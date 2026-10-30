import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectAgentEnv, setProjectAgentEnv } from './project-env.js';

afterEach(() => {
  setProjectAgentEnv('p1', undefined);
  setProjectAgentEnv('p2', undefined);
});

describe('project agent env registry', () => {
  it('returns nothing for an unknown or missing project', () => {
    expect(projectAgentEnv('nope')).toEqual({});
    expect(projectAgentEnv(undefined)).toEqual({});
  });

  it('keeps each project separate', () => {
    setProjectAgentEnv('p1', { CLAUDE_CONFIG_DIR: '/work' });
    setProjectAgentEnv('p2', { CLAUDE_CONFIG_DIR: '/personal' });
    expect(projectAgentEnv('p1')).toEqual({ CLAUDE_CONFIG_DIR: '/work' });
    expect(projectAgentEnv('p2')).toEqual({ CLAUDE_CONFIG_DIR: '/personal' });
  });

  it('expands only a leading ~ in values', () => {
    setProjectAgentEnv('p1', {
      CLAUDE_CONFIG_DIR: '~/.claude-work',
      BARE: '~',
      OTHER_USER: '~bob/x',
      MIDDLE: '/a/~/b',
    });
    expect(projectAgentEnv('p1')).toEqual({
      CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude-work'),
      BARE: os.homedir(),
      OTHER_USER: '~bob/x',
      MIDDLE: '/a/~/b',
    });
  });

  it('drops invalid keys from untrusted input', () => {
    setProjectAgentEnv('p1', { OK: '1', 'BAD;KEY': '2', NUM: 3 });
    expect(projectAgentEnv('p1')).toEqual({ OK: '1' });
  });

  it('clears a project when it is set to nothing', () => {
    setProjectAgentEnv('p1', { OK: '1' });
    setProjectAgentEnv('p1', {});
    expect(projectAgentEnv('p1')).toEqual({});
  });
});
