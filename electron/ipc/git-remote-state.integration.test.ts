import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkMergeStatus } from './git.js';

const directories: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function commit(cwd: string, file: string): void {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', file);
}
/** A task worktree on `child`, with a bare repository as origin when asked. */
function fixture(withOrigin: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'remote-state-'));
  directories.push(root);
  const repo = join(root, 'repo');
  git(root, 'init', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'test@example.test');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  appendFileSync(join(repo, '.git/info/exclude'), '/.worktrees/\n');
  commit(repo, 'base.txt');
  if (withOrigin) {
    git(root, 'init', '--bare', '-b', 'main', 'origin.git');
    git(repo, 'remote', 'add', 'origin', join(root, 'origin.git'));
  }
  const child = join(repo, '.worktrees/child');
  git(repo, 'worktree', 'add', '-b', 'child', child);
  commit(child, 'work.txt');
  return child;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('checkMergeStatus remote state', () => {
  it('tells a never-pushed branch from a stale and a current one', async () => {
    const child = fixture(true);
    expect((await checkMergeStatus(child, 'main')).remote).toBe('unpushed');
    git(child, 'push', '-u', 'origin', 'child');
    expect((await checkMergeStatus(child, 'main')).remote).toBe('pushed');
    commit(child, 'more.txt');
    expect((await checkMergeStatus(child, 'main')).remote).toBe('differs');
  });

  it('counts the commits each side lacks once they differ', async () => {
    const child = fixture(true);
    expect((await checkMergeStatus(child, 'main')).remote_divergence).toBeUndefined();
    git(child, 'push', '-u', 'origin', 'child');
    expect((await checkMergeStatus(child, 'main')).remote_divergence).toBeUndefined();
    commit(child, 'more.txt');
    commit(child, 'even-more.txt');
    expect((await checkMergeStatus(child, 'main')).remote_divergence).toEqual({
      ahead: 2,
      behind: 0,
    });
    // Back to the base: origin's copy now has the one commit the branch lost.
    git(child, 'reset', '--hard', 'main');
    expect((await checkMergeStatus(child, 'main')).remote_divergence).toEqual({
      ahead: 0,
      behind: 1,
    });
    commit(child, 'other.txt');
    expect((await checkMergeStatus(child, 'main')).remote_divergence).toEqual({
      ahead: 1,
      behind: 1,
    });
  });

  it("dates origin's copy by the last fetch or push, and not before either", async () => {
    const child = fixture(true);
    expect((await checkMergeStatus(child, 'main')).remote_seen_at).toBeUndefined();
    const before = Date.now() - 1_000;
    git(child, 'push', '-u', 'origin', 'child');
    const pushed = (await checkMergeStatus(child, 'main')).remote_seen_at;
    expect(pushed).toBeGreaterThanOrEqual(before);
    expect(pushed).toBeLessThanOrEqual(Date.now());
  });

  it('counts a fetch that changed nothing as fresh too', async () => {
    const child = fixture(true);
    git(child, 'push', '-u', 'origin', 'child');
    // Back-date the push, so only the fetch can make the date recent.
    const logs = git(child, 'rev-parse', '--git-common-dir');
    const reflog = resolve(child, logs, 'logs/refs/remotes/origin/child');
    writeFileSync(reflog, readFileSync(reflog, 'utf8').replace(/ \d{10} /g, ' 1000000000 '));
    expect((await checkMergeStatus(child, 'main')).remote_seen_at).toBe(1_000_000_000_000);
    const before = Date.now() - 1_000;
    git(child, 'fetch', 'origin');
    expect((await checkMergeStatus(child, 'main')).remote_seen_at).toBeGreaterThanOrEqual(before);
  });

  it('ignores a fetch that did not bring this branch', async () => {
    const child = fixture(true);
    git(child, 'push', '-u', 'origin', 'child');
    git(child, 'push', 'origin', 'main');
    const logs = git(child, 'rev-parse', '--git-common-dir');
    const reflog = resolve(child, logs, 'logs/refs/remotes/origin/child');
    writeFileSync(reflog, readFileSync(reflog, 'utf8').replace(/ \d{10} /g, ' 1000000000 '));
    git(child, 'fetch', 'origin', 'main');
    expect((await checkMergeStatus(child, 'main')).remote_seen_at).toBe(1_000_000_000_000);
  });

  it('reports nothing for a repository without an origin', async () => {
    const child = fixture(false);
    expect((await checkMergeStatus(child, 'main')).remote).toBeUndefined();
  });
});
