import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeBaseIntoTask } from './git.js';

const directories: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function commit(cwd: string, file: string, content: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', `${file}: ${content.trim()}`);
}
/** A repo whose `main` moved on after the `child` task branch was created. */
function fixture(childEdit: { file: string; content: string }) {
  const root = mkdtempSync(join(tmpdir(), 'sync-base-'));
  directories.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  appendFileSync(join(root, '.git/info/exclude'), '/.worktrees/\n');
  commit(root, 'base.txt', 'base\n');
  const child = join(root, '.worktrees/child');
  git(root, 'worktree', 'add', '-b', 'child', child);
  commit(child, childEdit.file, childEdit.content);
  commit(root, 'base.txt', 'main moved on\n');
  return { root, child };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('mergeBaseIntoTask', () => {
  it('merges the base into the task branch and keeps the task commits', async () => {
    const { child } = fixture({ file: 'result.txt', content: 'task work\n' });
    const before = git(child, 'rev-parse', 'HEAD');

    await mergeBaseIntoTask(child, 'main');

    expect(() => git(child, 'merge-base', '--is-ancestor', 'main', 'HEAD')).not.toThrow();
    expect(() => git(child, 'merge-base', '--is-ancestor', before, 'HEAD')).not.toThrow();
    expect(git(child, 'status', '--porcelain')).toBe('');
  });

  it('aborts a conflicting merge and leaves the branch as it was', async () => {
    const { child } = fixture({ file: 'base.txt', content: 'task edit\n' });
    const before = git(child, 'rev-parse', 'HEAD');

    await expect(mergeBaseIntoTask(child, 'main')).rejects.toThrow(/Merge failed/);

    expect(git(child, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(child, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(git(child, 'rev-parse', '--git-dir'), 'MERGE_HEAD'))).toBe(false);
  });
});
