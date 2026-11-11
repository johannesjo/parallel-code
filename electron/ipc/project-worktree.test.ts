import { afterEach, describe, expect, it } from 'vitest';
import { setProjectAgentEnv } from './project-env.js';
import {
  projectTeardownOptions,
  projectWorktreeDirs,
  setProjectWorktreeSettings,
} from './project-worktree.js';

afterEach(() => {
  setProjectWorktreeSettings('p1', {});
  setProjectWorktreeSettings('p2', {});
  setProjectAgentEnv('p1', undefined);
});

describe('project teardown script registry', () => {
  it("gives the project's script with its env, and nothing for other projects", () => {
    setProjectWorktreeSettings('p1', { teardownScript: 'docker compose down' });
    setProjectAgentEnv('p1', { COMPOSE_PROJECT_NAME: 'app' });
    expect(projectTeardownOptions('p1')).toEqual({
      teardownScript: 'docker compose down',
      teardownEnv: { COMPOSE_PROJECT_NAME: 'app' },
    });
    expect(projectTeardownOptions('p2')).toEqual({});
  });

  it('clears the script on an empty or missing value', () => {
    setProjectWorktreeSettings('p1', { teardownScript: 'rm -rf .cache' });
    setProjectWorktreeSettings('p1', { teardownScript: '  ' });
    expect(projectTeardownOptions('p1')).toEqual({});
    setProjectWorktreeSettings('p2', { teardownScript: 'rm -rf .cache' });
    setProjectWorktreeSettings('p2', {});
    expect(projectTeardownOptions('p2')).toEqual({});
  });

  it('rejects untrusted input and keeps the previous settings', () => {
    setProjectWorktreeSettings('p1', {
      teardownScript: 'make clean',
      includes: [{ name: '.env', mode: 'copy' }],
    });
    expect(() => setProjectWorktreeSettings('p1', { teardownScript: 42 })).toThrow();
    expect(() => setProjectWorktreeSettings('p1', { teardownScript: 'a\0b' })).toThrow();
    expect(() => setProjectWorktreeSettings('p1', { includes: 'node_modules' })).toThrow();
    expect(() =>
      setProjectWorktreeSettings('p1', { includes: [{ name: 'node_modules', mode: 'move' }] }),
    ).toThrow();
    expect(projectTeardownOptions('p1')).toEqual({ teardownScript: 'make clean', teardownEnv: {} });
    expect(projectWorktreeDirs('p1')).toEqual({ symlinkDirs: [], copyDirs: ['.env'] });
  });
});

describe('project worktree includes registry', () => {
  it('links node_modules when the project saved no list', () => {
    expect(projectWorktreeDirs('p1')).toEqual({ symlinkDirs: ['node_modules'], copyDirs: [] });
  });

  it("splits the project's saved list by mode", () => {
    setProjectWorktreeSettings('p1', {
      includes: [
        { name: 'node_modules', mode: 'copy' },
        { name: '.env', mode: 'symlink' },
      ],
    });
    expect(projectWorktreeDirs('p1')).toEqual({
      symlinkDirs: ['.env'],
      copyDirs: ['node_modules'],
    });
  });

  it('brings nothing in for a saved empty list', () => {
    setProjectWorktreeSettings('p1', { includes: [] });
    expect(projectWorktreeDirs('p1')).toEqual({ symlinkDirs: [], copyDirs: [] });
  });
});
