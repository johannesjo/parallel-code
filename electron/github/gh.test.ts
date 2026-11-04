import { describe, expect, it } from 'vitest';
import { describeGhError, parsePrRef, runGh } from './gh.js';

describe('runGh', () => {
  it('blames a missing project folder, not gh, when the cwd is gone', async () => {
    // Node reports a missing cwd as `spawn gh ENOENT`, exactly like a missing gh.
    await expect(runGh(['--version'], '/nonexistent/parallel-code-316')).rejects.toThrow(
      'Project folder not found: /nonexistent/parallel-code-316',
    );
  });
});

describe('describeGhError', () => {
  it('explains a missing gh binary', () => {
    const err = Object.assign(new Error('spawn gh ENOENT'), {
      code: 'ENOENT',
      path: 'gh',
      syscall: 'spawn gh',
    });
    const message = describeGhError(err);
    expect(message).toMatch(/not found on the app's PATH/);
    // gh may be installed where the app's PATH does not reach (#316).
    expect(message).toMatch(/already installed.*restart Parallel Code/);
  });

  it('does not blame gh for a missing working directory', () => {
    const err = Object.assign(new Error('spawn /bin/sh ENOENT'), { code: 'ENOENT', path: '/x' });
    expect(describeGhError(err)).toBe('spawn /bin/sh ENOENT');
  });

  it('explains a project without a GitHub remote', () => {
    expect(describeGhError({ stderr: 'no git remotes found' })).toMatch(/no GitHub remote/);
  });

  it('explains missing auth when gh has no account at all', () => {
    const stderr =
      'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n';
    expect(describeGhError({ stderr, code: 4 })).toBe(
      'GitHub CLI is not logged in. Run "gh auth login" in a terminal.',
    );
  });

  it('does not read the unknown-host gh auth login hint as logged out', () => {
    // Real gh wording (2.101-2.103) for a logged-in user with a non-GitHub remote.
    const stderr =
      'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`';
    expect(describeGhError({ stderr })).toBe('This project has no GitHub remote.');
  });

  it('explains missing auth', () => {
    expect(describeGhError({ stderr: 'You are not logged into any GitHub hosts.' })).toMatch(
      /not logged in/,
    );
  });

  it('explains an ambiguous repository', () => {
    const stderr =
      'X No default remote repository has been set. To learn more about the default repository, run: gh repo set-default --help\n';
    expect(describeGhError({ stderr })).toMatch(/Run "gh repo set-default" in the project folder/);
  });

  it('reports the last stderr line otherwise', () => {
    expect(describeGhError({ stderr: 'warning\nGraphQL: Not Found\n' })).toBe(
      'gh: GraphQL: Not Found',
    );
  });
});

describe('parsePrRef', () => {
  it('parses a canonical PR URL', () => {
    expect(parsePrRef('https://github.com/o/r.js/pull/12')).toEqual({
      host: 'github.com',
      owner: 'o',
      repo: 'r.js',
      number: 12,
    });
    expect(parsePrRef('https://github.com/o/r/pull/12/files')?.number).toBe(12);
  });

  it('preserves arbitrary enterprise hosts', () => {
    expect(parsePrRef('https://code.acme.test/o/r/pull/42')).toEqual({
      host: 'code.acme.test',
      owner: 'o',
      repo: 'r',
      number: 42,
    });
  });

  it.each([
    'http://github.com/o/r/pull/1',
    'https://gitlab.com/o/r/-/merge_requests/1',
    'https://user:pw@github.com/o/r/pull/1',
    'https://github.com/o/r/issues/1',
    'https://github.com/o/r/pull/abc',
    'not a url',
  ])('rejects %s', (url) => {
    expect(parsePrRef(url)).toBeNull();
  });
});
