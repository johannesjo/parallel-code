import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { acquireEnv, clearLease, envStatus, readLease, releaseEnv } from './pool.js';

let root: string;

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
    },
  }).trim();
}

/** An environment with a repos.tsv manifest and one committed repo per name. */
function makeEnv(name: string, repos: string[]): string {
  const envPath = path.join(root, name);
  fs.mkdirSync(envPath, { recursive: true });
  fs.writeFileSync(
    path.join(envPath, 'repos.tsv'),
    repos.map((repo) => `${repo}\tgit@example.com:acme/${repo}.git`).join('\n'),
  );
  for (const repo of repos) {
    const repoPath = path.join(envPath, repo);
    fs.mkdirSync(repoPath);
    git(repoPath, 'init', '--initial-branch=dev', '--quiet');
    fs.writeFileSync(path.join(repoPath, 'README.md'), `# ${repo}\n`);
    git(repoPath, 'add', '.');
    git(repoPath, 'commit', '--quiet', '-m', 'initial');
  }
  return envPath;
}

function branchOf(repoPath: string): string {
  return git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD');
}

function branchExists(repoPath: string, branch: string): boolean {
  return git(repoPath, 'branch', '--list', branch).length > 0;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('envStatus', () => {
  it('reports a ready environment with no blockers', async () => {
    const envPath = makeEnv('MRW1', ['waiter', 'api']);
    const status = await envStatus(envPath, undefined, new Set());
    expect(status.blockers).toEqual([]);
    expect(status.members.map((member) => member.name)).toEqual(['waiter', 'api']);
    expect(status.lease).toBeNull();
  });

  it('blocks on a missing folder', async () => {
    const status = await envStatus(path.join(root, 'nope'), undefined, new Set());
    expect(status.exists).toBe(false);
    expect(status.blockers).toEqual([{ reason: 'Environment folder not found' }]);
  });

  it('names the repo that is dirty rather than failing the environment', async () => {
    const envPath = makeEnv('MRW1', ['waiter', 'api']);
    fs.writeFileSync(path.join(envPath, 'waiter', 'scratch.txt'), 'wip');
    const status = await envStatus(envPath, undefined, new Set());
    expect(status.blockers).toEqual([{ repo: 'waiter', reason: 'Has uncommitted changes' }]);
  });

  it('reports a declared-but-uncloned repo without refusing the environment', async () => {
    // Manifests drift from the checkouts beside them: the Winston dev-env's
    // repos.tsv names three repositories nobody clones. Blocking on those
    // would make the pool unusable.
    const envPath = makeEnv('MRW3', ['waiter']);
    fs.appendFileSync(path.join(envPath, 'repos.tsv'), '\napi\tgit@example.com:acme/api.git\n');
    const status = await envStatus(envPath, undefined, new Set());
    expect(status.missing).toEqual(['api']);
    expect(status.blockers).toEqual([]);
  });

  it('treats a lease whose task is gone as free', async () => {
    const envPath = makeEnv('MRW1', ['waiter']);
    await acquireEnv({
      envPaths: [envPath],
      taskId: 'task-1',
      taskName: 'old work',
      branchName: 'task/one',
      liveTaskIds: ['task-1'],
    });
    git(path.join(envPath, 'waiter'), 'checkout', '--quiet', 'dev');
    git(path.join(envPath, 'waiter'), 'branch', '-D', 'task/one');

    expect((await envStatus(envPath, undefined, new Set(['task-1']))).lease).not.toBeNull();
    expect((await envStatus(envPath, undefined, new Set())).lease).toBeNull();
  });
});

describe('acquireEnv', () => {
  it('leases the first free environment and branches every member repo', async () => {
    const one = makeEnv('MRW1', ['waiter', 'api']);
    makeEnv('MRW2', ['waiter', 'api']);

    const result = await acquireEnv({
      envPaths: [one, path.join(root, 'MRW2')],
      taskId: 'task-1',
      taskName: 'ticket work',
      branchName: 'task/win-1',
      liveTaskIds: [],
    });

    expect(result.envPath).toBe(one);
    expect(result.repos.map((repo) => repo.name)).toEqual(['waiter', 'api']);
    expect(result.repos.every((repo) => repo.baseBranch === 'dev')).toBe(true);
    expect(branchOf(path.join(one, 'waiter'))).toBe('task/win-1');
    expect(branchOf(path.join(one, 'api'))).toBe('task/win-1');
    expect(readLease(one)?.taskId).toBe('task-1');
  });

  it('skips a leased environment and takes the next one', async () => {
    const one = makeEnv('MRW1', ['waiter']);
    const two = makeEnv('MRW2', ['waiter']);
    await acquireEnv({
      envPaths: [one, two],
      taskId: 'task-1',
      taskName: 'first',
      branchName: 'task/one',
      liveTaskIds: [],
    });

    const second = await acquireEnv({
      envPaths: [one, two],
      taskId: 'task-2',
      taskName: 'second',
      branchName: 'task/two',
      liveTaskIds: ['task-1'],
    });
    expect(second.envPath).toBe(two);
  });

  it('fails with every environment’s reason when the pool is full', async () => {
    const one = makeEnv('MRW1', ['waiter']);
    const two = makeEnv('MRW2', ['waiter']);
    fs.writeFileSync(path.join(two, 'waiter', 'scratch.txt'), 'wip');
    await acquireEnv({
      envPaths: [one, two],
      taskId: 'task-1',
      taskName: 'first',
      branchName: 'task/one',
      liveTaskIds: [],
    });

    await expect(
      acquireEnv({
        envPaths: [one, two],
        taskId: 'task-2',
        taskName: 'second',
        branchName: 'task/two',
        liveTaskIds: ['task-1'],
      }),
    ).rejects.toThrow(/No pool environment is free[\s\S]*Leased by task "first"[\s\S]*uncommitted/);
  });

  it('rolls the whole environment back when one repo refuses the branch', async () => {
    const envPath = makeEnv('MRW1', ['waiter', 'api']);
    // `api` already has the branch, so creating it there fails after `waiter`
    // has already been switched.
    git(path.join(envPath, 'api'), 'branch', 'task/win-1');

    await expect(
      acquireEnv({
        envPaths: [envPath],
        taskId: 'task-1',
        taskName: 'ticket work',
        branchName: 'task/win-1',
        liveTaskIds: [],
      }),
    ).rejects.toThrow(/nothing was changed/);

    expect(branchOf(path.join(envPath, 'waiter'))).toBe('dev');
    expect(branchExists(path.join(envPath, 'waiter'), 'task/win-1')).toBe(false);
    expect(readLease(envPath)).toBeNull();
  });
});

describe('releaseEnv', () => {
  it('restores every repo and drops an unused branch', async () => {
    const envPath = makeEnv('MRW1', ['waiter', 'api']);
    const { repos } = await acquireEnv({
      envPaths: [envPath],
      taskId: 'task-1',
      taskName: 'ticket work',
      branchName: 'task/win-1',
      liveTaskIds: [],
    });

    const result = await releaseEnv({ envPath, repos });

    expect(result).toEqual({ keptBranches: [], failures: [] });
    expect(branchOf(path.join(envPath, 'waiter'))).toBe('dev');
    expect(branchExists(path.join(envPath, 'waiter'), 'task/win-1')).toBe(false);
    expect(readLease(envPath)).toBeNull();
  });

  it('keeps a branch that holds commits, and deletes it when forced', async () => {
    const envPath = makeEnv('MRW1', ['waiter', 'api']);
    const { repos } = await acquireEnv({
      envPaths: [envPath],
      taskId: 'task-1',
      taskName: 'ticket work',
      branchName: 'task/win-1',
      liveTaskIds: [],
    });
    const waiter = path.join(envPath, 'waiter');
    fs.writeFileSync(path.join(waiter, 'feature.txt'), 'done\n');
    git(waiter, 'add', '.');
    git(waiter, 'commit', '--quiet', '-m', 'WIN-1 | feature');

    const kept = await releaseEnv({ envPath, repos });
    expect(kept.keptBranches).toEqual(['waiter']);
    expect(branchOf(waiter)).toBe('dev');
    expect(branchExists(waiter, 'task/win-1')).toBe(true);
    // The unused branch in the sibling repo is gone either way.
    expect(branchExists(path.join(envPath, 'api'), 'task/win-1')).toBe(false);

    clearLease(envPath);
    const forced = await releaseEnv({ envPath, repos, force: true });
    expect(forced.keptBranches).toEqual([]);
    expect(branchExists(waiter, 'task/win-1')).toBe(false);
  });

  it('reports a repo it could not restore and still frees the environment', async () => {
    const envPath = makeEnv('MRW1', ['waiter']);
    const { repos } = await acquireEnv({
      envPaths: [envPath],
      taskId: 'task-1',
      taskName: 'ticket work',
      branchName: 'task/win-1',
      liveTaskIds: [],
    });
    fs.rmSync(path.join(envPath, 'waiter'), { recursive: true, force: true });

    const result = await releaseEnv({ envPath, repos });
    expect(result.failures.map((failure) => failure.repo)).toEqual(['waiter']);
    expect(readLease(envPath)).toBeNull();
  });
});
