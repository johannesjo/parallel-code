// Integration test against real git: a plain (non-squash) merge into a base that
// moved on after the task branched keeps the base's history linear.
import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeTask } from './git.js';

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
function fixture(mainEdit: { file: string; content: string }) {
  const root = mkdtempSync(join(tmpdir(), 'merge-linear-'));
  directories.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  appendFileSync(join(root, '.git/info/exclude'), '/.worktrees/\n');
  commit(root, 'base.txt', 'base\n');
  const child = join(root, '.worktrees/child');
  git(root, 'worktree', 'add', '-b', 'child', child);
  commit(child, 'base.txt', 'task work\n');
  commit(root, mainEdit.file, mainEdit.content);
  return { root, child };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('replays the task onto a base that moved on instead of adding a merge commit', async () => {
  const { root, child } = fixture({ file: 'other.txt', content: 'main moved on\n' });

  await mergeTask(root, 'child', false, null, false, 'main', child);

  expect(git(root, 'rev-list', '--merges', 'main')).toBe('');
  expect(git(root, 'log', '--format=%s', 'main')).toBe(
    ['base.txt: task work', 'other.txt: main moved on', 'base.txt: base'].join('\n'),
  );
  expect(git(child, 'rev-parse', 'HEAD')).toBe(git(root, 'rev-parse', 'main'));
});

it('leaves both branches unchanged when the task conflicts with the base', async () => {
  const { root, child } = fixture({ file: 'base.txt', content: 'main moved on\n' });
  const mainBefore = git(root, 'rev-parse', 'main');
  const childBefore = git(child, 'rev-parse', 'HEAD');

  await expect(mergeTask(root, 'child', false, null, false, 'main', child)).rejects.toThrow(
    /conflicts in .*base\.txt/,
  );

  expect(git(root, 'rev-parse', 'main')).toBe(mainBefore);
  expect(git(child, 'rev-parse', 'HEAD')).toBe(childBefore);
  expect(git(child, 'status', '--porcelain')).toBe('');
  expect(git(root, 'status', '--porcelain')).toBe('');
});
