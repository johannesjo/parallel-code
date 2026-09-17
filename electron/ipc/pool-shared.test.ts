import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  aggregateMirrors,
  alignMirrors,
  findSharedMirrors,
  submodulePaths,
  unaggregatedMirrors,
} from './pool-shared.js';
import type { PoolRepo } from './pool.js';

let root: string;
let repos: PoolRepo[];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      // Local paths as submodule sources are refused by default since CVE-2022-39253.
      GIT_ALLOW_PROTOCOL: 'file',
    },
  }).trim();
}

function repo(name: string): PoolRepo {
  return {
    name,
    path: path.join(root, name),
    branchName: 'task/win-1',
    baseBranch: 'dev',
  };
}

/**
 * An environment shaped like the real thing: a canonical `shared` repository at
 * the root, and a `waiter` application carrying its own submodule copy of it
 * pinned to an *older* commit — the pin gap that alignment exists to close.
 */
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-shared-'));

  const shared = path.join(root, 'shared');
  fs.mkdirSync(shared);
  git(shared, 'init', '--initial-branch=dev', '--quiet');
  fs.writeFileSync(path.join(shared, 'index.ts'), 'export const version = 1;\n');
  git(shared, 'add', '.');
  git(shared, 'commit', '--quiet', '-m', 'v1');
  const oldPin = git(shared, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(shared, 'index.ts'), 'export const version = 2;\n');
  git(shared, 'add', '.');
  git(shared, 'commit', '--quiet', '-m', 'v2');

  const waiter = path.join(root, 'waiter');
  fs.mkdirSync(waiter);
  git(waiter, 'init', '--initial-branch=dev', '--quiet');
  fs.writeFileSync(path.join(waiter, 'app.ts'), 'export const app = true;\n');
  git(waiter, 'add', '.');
  git(waiter, 'commit', '--quiet', '-m', 'initial');
  git(
    waiter,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--quiet',
    shared,
    'packages/shared',
  );
  git(path.join(waiter, 'packages/shared'), 'checkout', '--quiet', '--detach', oldPin);
  git(waiter, 'add', '.');
  git(waiter, 'commit', '--quiet', '-m', 'pin shared to v1');

  // Both repos on the task branch, as a lease would leave them.
  for (const name of ['shared', 'waiter'])
    git(path.join(root, name), 'checkout', '--quiet', '-b', 'task/win-1');
  repos = [repo('shared'), repo('waiter')];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('submodulePaths', () => {
  it('reads the declared paths, and nothing for a repo without submodules', async () => {
    await expect(submodulePaths(path.join(root, 'waiter'))).resolves.toEqual(['packages/shared']);
    await expect(submodulePaths(path.join(root, 'shared'))).resolves.toEqual([]);
  });
});

describe('findSharedMirrors', () => {
  it('matches a submodule to the member repo of the same name', async () => {
    const mirrors = await findSharedMirrors(repos);
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0]).toMatchObject({ hostName: 'waiter', subPath: 'packages/shared' });
    expect(mirrors[0].canonical.name).toBe('shared');
  });

  it('ignores a submodule the environment keeps no canonical copy of', async () => {
    const mirrors = await findSharedMirrors([repo('waiter')]);
    expect(mirrors).toEqual([]);
  });
});

describe('alignMirrors', () => {
  it('moves the copy from its stale pin onto the canonical base branch', async () => {
    const mirrorPath = path.join(root, 'waiter', 'packages/shared');
    expect(fs.readFileSync(path.join(mirrorPath, 'index.ts'), 'utf8')).toContain('version = 1');

    const outcomes = await alignMirrors(await findSharedMirrors(repos));

    expect(outcomes).toEqual([{ mirror: 'waiter/packages/shared' }]);
    expect(fs.readFileSync(path.join(mirrorPath, 'index.ts'), 'utf8')).toContain('version = 2');
    // Detached: the copy is a build input, not where commits belong.
    expect(git(mirrorPath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
  });
});

describe('aggregateMirrors', () => {
  async function alignedMirrors() {
    const mirrors = await findSharedMirrors(repos);
    await alignMirrors(mirrors);
    return mirrors;
  }

  it('carries an edit made in the copy into the canonical checkout, uncommitted', async () => {
    const mirrors = await alignedMirrors();
    fs.writeFileSync(
      path.join(root, 'waiter', 'packages/shared', 'index.ts'),
      'export const version = 2;\nexport const extra = true;\n',
    );

    const outcomes = await aggregateMirrors(mirrors);

    expect(outcomes).toEqual([{ mirror: 'waiter/packages/shared', applied: true }]);
    const canonical = path.join(root, 'shared', 'index.ts');
    expect(fs.readFileSync(canonical, 'utf8')).toContain('extra = true');
    // Left in the working tree: the commit message is the author's.
    expect(git(path.join(root, 'shared'), 'status', '--porcelain')).toContain('index.ts');
  });

  it('carries a new file across too', async () => {
    const mirrors = await alignedMirrors();
    fs.writeFileSync(
      path.join(root, 'waiter', 'packages/shared', 'added.ts'),
      'export const b = 1;\n',
    );

    await aggregateMirrors(mirrors);

    expect(fs.existsSync(path.join(root, 'shared', 'added.ts'))).toBe(true);
  });

  it('carries commits made inside the copy, not just uncommitted work', async () => {
    const mirrors = await alignedMirrors();
    const mirrorPath = path.join(root, 'waiter', 'packages/shared');
    fs.writeFileSync(path.join(mirrorPath, 'index.ts'), 'export const version = 3;\n');
    git(mirrorPath, 'add', '.');
    git(mirrorPath, 'commit', '--quiet', '-m', 'committed in the copy');

    await aggregateMirrors(mirrors);

    expect(fs.readFileSync(path.join(root, 'shared', 'index.ts'), 'utf8')).toContain('version = 3');
  });

  it('is idempotent: a second run reports nothing left to carry', async () => {
    const mirrors = await alignedMirrors();
    fs.writeFileSync(
      path.join(root, 'waiter', 'packages/shared', 'index.ts'),
      'export const version = 2;\nexport const extra = true;\n',
    );

    await aggregateMirrors(mirrors);
    expect(await aggregateMirrors(mirrors)).toEqual([
      { mirror: 'waiter/packages/shared', applied: false },
    ]);
  });

  it('reports nothing to do when the copy is untouched', async () => {
    expect(await aggregateMirrors(await alignedMirrors())).toEqual([
      { mirror: 'waiter/packages/shared', applied: false },
    ]);
  });
});

describe('unaggregatedMirrors', () => {
  it('names a copy holding changes, and goes quiet once they are carried across', async () => {
    const mirrors = await findSharedMirrors(repos);
    await alignMirrors(mirrors);
    fs.writeFileSync(
      path.join(root, 'waiter', 'packages/shared', 'index.ts'),
      'export const version = 2;\nexport const extra = true;\n',
    );

    expect(await unaggregatedMirrors(mirrors)).toEqual(['waiter/packages/shared']);
    await aggregateMirrors(mirrors);
    expect(await unaggregatedMirrors(mirrors)).toEqual([]);
  });
});
