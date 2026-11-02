import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('reports nothing for a repository without an origin', async () => {
    const child = fixture(false);
    expect((await checkMergeStatus(child, 'main')).remote).toBeUndefined();
  });
});
