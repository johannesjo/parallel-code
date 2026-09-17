import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  poolAllDiffs,
  poolChangedFiles,
  poolFileDiff,
  poolStatus,
  prefixChangedFiles,
  prefixDiffPaths,
  splitRepoPath,
} from './pool-git.js';
import type { PoolRepo } from './pool.js';
import type { ChangedFile } from './shared-types.js';

const repos: PoolRepo[] = [
  { name: 'waiter', path: '/envs/MRW1/waiter', branchName: 'task/win-1', baseBranch: 'dev' },
  { name: 'shared', path: '/envs/MRW1/shared', branchName: 'task/win-1', baseBranch: 'dev' },
];

describe('splitRepoPath', () => {
  it('routes a path to the repository that owns it', () => {
    expect(splitRepoPath(repos, 'shared/client/index.ts')).toEqual({
      repo: repos[1],
      filePath: 'client/index.ts',
    });
  });

  it('returns null for a path outside every member repo', () => {
    expect(splitRepoPath(repos, 'repos.tsv')).toBeNull();
    expect(splitRepoPath(repos, 'waiterish/file.ts')).toBeNull();
  });

  it('falls back to the environment’s own repository for an unprefixed path', () => {
    const root = { name: '.', path: '/envs/MRW1', branchName: 'task/win-1', baseBranch: 'dev' };
    const withRoot = [...repos, root];
    expect(splitRepoPath(withRoot, 'repos.tsv')).toEqual({ repo: root, filePath: 'repos.tsv' });
    // A child repo's file still routes to the child, not to the fallback.
    expect(splitRepoPath(withRoot, 'waiter/src/a.ts')).toEqual({
      repo: repos[0],
      filePath: 'src/a.ts',
    });
  });
});

describe('prefixChangedFiles', () => {
  it('re-roots paths, including a rename’s previous path', () => {
    const files: ChangedFile[] = [
      {
        path: 'src/new.ts',
        previous_path: 'src/old.ts',
        lines_added: 1,
        lines_removed: 1,
        status: 'R',
        committed: true,
      },
    ];
    expect(prefixChangedFiles('waiter', files)[0]).toMatchObject({
      path: 'waiter/src/new.ts',
      previous_path: 'waiter/src/old.ts',
    });
  });
});

describe('the environment’s own repository', () => {
  it('keeps its paths as they are, in file lists and in diffs', () => {
    const files: ChangedFile[] = [
      { path: 'repos.tsv', lines_added: 1, lines_removed: 0, status: 'M', committed: false },
    ];
    expect(prefixChangedFiles('.', files)).toEqual(files);
    const diff = '--- a/repos.tsv\n+++ b/repos.tsv';
    expect(prefixDiffPaths('.', diff)).toBe(diff);
  });
});

describe('prefixDiffPaths', () => {
  it('re-roots the path-bearing headers only', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(prefixDiffPaths('waiter', diff).split('\n')).toEqual([
      'diff --git a/waiter/src/a.ts b/waiter/src/a.ts',
      'index 111..222 100644',
      '--- a/waiter/src/a.ts',
      '+++ b/waiter/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ]);
  });

  it('re-roots a rename and leaves diff-shaped body lines alone', () => {
    const diff = ['rename from src/old.ts', 'rename to src/new.ts', '+--- a/not/a/header'].join(
      '\n',
    );
    expect(prefixDiffPaths('shared', diff).split('\n')).toEqual([
      'rename from shared/src/old.ts',
      'rename to shared/src/new.ts',
      '+--- a/not/a/header',
    ]);
  });

  it('leaves /dev/null in place, so an added file still parses', () => {
    const diff = ['--- /dev/null', '+++ b/src/new.ts'].join('\n');
    expect(prefixDiffPaths('waiter', diff).split('\n')).toEqual([
      '--- /dev/null',
      '+++ b/waiter/src/new.ts',
    ]);
  });
});

describe('against real repositories', () => {
  let root: string;
  let envRepos: PoolRepo[];

  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-git-'));
    envRepos = ['waiter', 'shared'].map((name) => {
      const repoPath = path.join(root, name);
      fs.mkdirSync(repoPath);
      git(repoPath, 'init', '--initial-branch=dev', '--quiet');
      fs.writeFileSync(path.join(repoPath, 'index.ts'), 'export const a = 1;\n');
      git(repoPath, 'add', '.');
      git(repoPath, 'commit', '--quiet', '-m', 'initial');
      git(repoPath, 'checkout', '--quiet', '-b', 'task/win-1');
      return { name, path: repoPath, branchName: 'task/win-1', baseBranch: 'dev' };
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists changed files from every repo under its own name', async () => {
    fs.writeFileSync(path.join(root, 'waiter', 'index.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(root, 'shared', 'added.ts'), 'export const b = 3;\n');

    const files = await poolChangedFiles(envRepos);
    expect(files.map((file) => file.path).sort()).toEqual(['shared/added.ts', 'waiter/index.ts']);
  });

  it('diffs a file in the repo that owns it', async () => {
    fs.writeFileSync(path.join(root, 'shared', 'index.ts'), 'export const a = 99;\n');
    const diff = await poolFileDiff(envRepos, 'shared/index.ts');
    expect(diff.newContent).toContain('99');
  });

  it('concatenates every repo’s diff with paths re-rooted at the environment', async () => {
    fs.writeFileSync(path.join(root, 'waiter', 'index.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(root, 'shared', 'index.ts'), 'export const a = 3;\n');

    const diff = await poolAllDiffs(envRepos);
    expect(diff).toContain('a/waiter/index.ts');
    expect(diff).toContain('a/shared/index.ts');
  });

  it('refuses a path no member repo owns', async () => {
    await expect(poolFileDiff(envRepos, 'repos.tsv')).rejects.toThrow(/No pool repository owns/);
  });

  it('rolls per-repo status up, and reports a mixed branch as none', async () => {
    fs.writeFileSync(path.join(root, 'waiter', 'index.ts'), 'export const a = 2;\n');

    const agreed = await poolStatus(envRepos);
    expect(agreed.combined.has_uncommitted_changes).toBe(true);
    expect(agreed.combined.current_branch).toBe('task/win-1');
    expect(agreed.perRepo.map((status) => status.repo)).toEqual(['waiter', 'shared']);

    git(path.join(root, 'shared'), 'checkout', '--quiet', 'dev');
    const mixed = await poolStatus(envRepos);
    expect(mixed.combined.current_branch).toBeNull();
  });
});
