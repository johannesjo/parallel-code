import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ROOT_MEMBER,
  discoverMembers,
  isSafeMemberName,
  parseRepoManifest,
  readManifest,
  scanForMembers,
} from './pool-members.js';

let envPath: string;

beforeEach(() => {
  envPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-members-'));
});

afterEach(() => {
  fs.rmSync(envPath, { recursive: true, force: true });
});

/** A checked-out member: a directory with a `.git` entry in it. */
function makeRepo(name: string, gitEntry: 'dir' | 'file' = 'dir'): void {
  const repo = path.join(envPath, name);
  fs.mkdirSync(repo, { recursive: true });
  if (gitEntry === 'dir') fs.mkdirSync(path.join(repo, '.git'));
  else fs.writeFileSync(path.join(repo, '.git'), 'gitdir: ../.git/modules/x');
}

describe('isSafeMemberName', () => {
  it('accepts an ordinary directory name', () => {
    expect(isSafeMemberName('waiter')).toBe(true);
    expect(isSafeMemberName('report-service')).toBe(true);
  });

  it('rejects anything that would leave the environment root', () => {
    expect(isSafeMemberName('..')).toBe(false);
    expect(isSafeMemberName('../etc')).toBe(false);
    expect(isSafeMemberName('a/b')).toBe(false);
    expect(isSafeMemberName('a\\b')).toBe(false);
  });

  it('rejects dotted, empty, newline and untrimmed names', () => {
    expect(isSafeMemberName('.git')).toBe(false);
    expect(isSafeMemberName('.worktrees')).toBe(false);
    expect(isSafeMemberName('')).toBe(false);
    expect(isSafeMemberName('waiter\nrm -rf')).toBe(false);
    expect(isSafeMemberName(' waiter')).toBe(false);
  });
});

describe('parseRepoManifest', () => {
  it('reads name, skips the url, and keeps a branch override', () => {
    const members = parseRepoManifest(
      ['api\tgit@bitbucket.org:possys/api.git', 'reports\tgit@host:possys/reports.git\tmain'].join(
        '\n',
      ),
    );
    expect(members).toEqual([
      { name: 'api', branch: undefined },
      { name: 'reports', branch: 'main' },
    ]);
  });

  it('splits on any whitespace, not tabs alone', () => {
    // The Winston dev-env's own repos.tsv has a space-separated row.
    expect(parseRepoManifest('report-service git@host:possys/report-service.git')).toEqual([
      { name: 'report-service', branch: undefined },
    ]);
  });

  it('skips comments and blank lines', () => {
    expect(parseRepoManifest('# a comment\n\n   \napi\tgit@host:api.git')).toEqual([
      { name: 'api', branch: undefined },
    ]);
  });

  it('keeps the first of a duplicated name', () => {
    const members = parseRepoManifest(
      'report-service\tgit@host:a.git\treports\nreport-service git@host:b.git',
    );
    expect(members).toEqual([{ name: 'report-service', branch: 'reports' }]);
  });

  it('drops an unsafe row without losing the file', () => {
    const members = parseRepoManifest('../escape\tgit@host:a.git\napi\tgit@host:api.git');
    expect(members).toEqual([{ name: 'api', branch: undefined }]);
  });
});

describe('readManifest', () => {
  it('returns null when the environment has no manifest', () => {
    expect(readManifest(envPath)).toBeNull();
  });

  it('reads repos.tsv from the environment root', () => {
    fs.writeFileSync(path.join(envPath, 'repos.tsv'), 'waiter\tgit@host:waiter.git\n');
    expect(readManifest(envPath)).toEqual([{ name: 'waiter', branch: undefined }]);
  });
});

describe('scanForMembers', () => {
  it('finds child git repositories and ignores everything else', () => {
    makeRepo('waiter');
    makeRepo('shared', 'file');
    fs.mkdirSync(path.join(envPath, 'scripts'));
    fs.mkdirSync(path.join(envPath, '.worktrees'));
    fs.writeFileSync(path.join(envPath, 'README.md'), '');
    expect(scanForMembers(envPath)).toEqual([{ name: 'shared' }, { name: 'waiter' }]);
  });

  it('returns nothing for an unreadable environment', () => {
    expect(scanForMembers(path.join(envPath, 'does-not-exist'))).toEqual([]);
  });
});

describe('discoverMembers', () => {
  it('prefers the manifest and reports declared repos that are not cloned yet', () => {
    fs.writeFileSync(
      path.join(envPath, 'repos.tsv'),
      'waiter\tgit@host:waiter.git\napi\tgit@host:api.git\n',
    );
    makeRepo('waiter');
    expect(discoverMembers(envPath)).toEqual({
      members: [{ name: 'waiter', branch: undefined }],
      missing: ['api'],
    });
  });

  it('falls back to a scan when there is no manifest', () => {
    makeRepo('waiter');
    expect(discoverMembers(envPath)).toEqual({ members: [{ name: 'waiter' }], missing: [] });
  });

  it("uses the project's own list ahead of the manifest", () => {
    fs.writeFileSync(path.join(envPath, 'repos.tsv'), 'waiter\tgit@host:waiter.git\n');
    makeRepo('waiter');
    makeRepo('api');
    expect(discoverMembers(envPath, ['api'])).toEqual({ members: [{ name: 'api' }], missing: [] });
  });

  it('includes the environment’s own repository when the root is a checkout', () => {
    fs.mkdirSync(path.join(envPath, '.git'));
    fs.writeFileSync(path.join(envPath, 'repos.tsv'), 'waiter\tgit@host:waiter.git\n');
    makeRepo('waiter');
    expect(discoverMembers(envPath)).toEqual({
      members: [{ name: ROOT_MEMBER }, { name: 'waiter', branch: undefined }],
      missing: [],
    });
  });

  it('leaves the root out when the environment root is not a repository', () => {
    makeRepo('waiter');
    expect(discoverMembers(envPath).members).toEqual([{ name: 'waiter' }]);
  });

  it('leaves the root out of an explicit list that does not name it', () => {
    fs.mkdirSync(path.join(envPath, '.git'));
    makeRepo('waiter');
    expect(discoverMembers(envPath, ['waiter']).members).toEqual([{ name: 'waiter' }]);
    expect(discoverMembers(envPath, [ROOT_MEMBER, 'waiter']).members).toEqual([
      { name: ROOT_MEMBER },
      { name: 'waiter' },
    ]);
  });

  it('drops an unsafe configured name instead of building a path from it', () => {
    makeRepo('api');
    expect(discoverMembers(envPath, ['../etc', 'api'])).toEqual({
      members: [{ name: 'api' }],
      missing: [],
    });
  });
});
