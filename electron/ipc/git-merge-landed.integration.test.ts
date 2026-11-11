// Integration test against real git: a task whose commits were cherry-picked
// onto the base reads as landed, not as conflicting, once the base moved on.
import { it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { checkMergeStatus } from './git.js';

let base: string;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function commit(cwd: string, file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
  run(cwd, ['add', file]);
  run(cwd, ['commit', '-m', message]);
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-landed-it-'));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** A repo on main with a task worktree on task/a, which has no commits yet. */
function repo(): { root: string; worktree: string } {
  const root = fs.mkdtempSync(path.join(base, 'repo-'));
  run(root, ['init', '-b', 'main']);
  run(root, ['config', 'user.email', 'test@test.local']);
  run(root, ['config', 'user.name', 'Test']);
  run(root, ['config', 'commit.gpgsign', 'false']);
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '/.worktrees/\n');
  commit(root, 'app.txt', 'one\n', 'initial');
  const worktree = path.join(root, '.worktrees', 'task', 'a');
  run(root, ['worktree', 'add', '-b', 'task/a', worktree]);
  return { root, worktree };
}

it('reports a task cherry-picked onto main, then edited there, as landed', async () => {
  const { root, worktree } = repo();
  commit(worktree, 'app.txt', 'two\n', 'task change');
  // -x makes a distinct commit; picked in the same second it could equal the original.
  run(root, ['cherry-pick', '-x', 'task/a']);
  commit(root, 'app.txt', 'three\n', 'later main change');

  const status = await checkMergeStatus(worktree, 'main');

  expect(status.already_landed).toBe(true);
  expect(status.conflicting_files).toEqual([]);
  expect(status.main_ahead_count).toBe(0);
});

it('reports a task whose commits were all cherry-picked as landed', async () => {
  const { root, worktree } = repo();
  commit(worktree, 'app.txt', 'two\n', 'first');
  commit(worktree, 'other.txt', 'more\n', 'second');
  run(root, ['cherry-pick', '-x', 'main..task/a']);
  commit(root, 'app.txt', 'three\n', 'later main change');

  const status = await checkMergeStatus(worktree, 'main');

  expect(status.already_landed).toBe(true);
});

it('does not report a picked task with a merge commit as landed', async () => {
  const { root, worktree } = repo();
  commit(worktree, 'app.txt', 'two\n', 'task change');
  const picked = run(worktree, ['rev-parse', 'HEAD']).trim();
  commit(root, 'base.txt', 'base\n', 'main change');
  // Merged before the pick: the merge could hold work of its own the pick lacks.
  run(worktree, ['merge', '--no-edit', 'main']);
  run(root, ['cherry-pick', '-x', picked]);

  const status = await checkMergeStatus(worktree, 'main');

  expect(status.already_landed).toBeUndefined();
});

it('does not report a partly cherry-picked task as landed', async () => {
  const { root, worktree } = repo();
  commit(worktree, 'app.txt', 'two\n', 'picked');
  const picked = run(worktree, ['rev-parse', 'HEAD']).trim();
  commit(worktree, 'other.txt', 'more\n', 'not picked');
  run(root, ['cherry-pick', '-x', picked]);
  commit(root, 'app.txt', 'three\n', 'later main change');

  const status = await checkMergeStatus(worktree, 'main');

  expect(status.already_landed).toBeUndefined();
});

it('does not report a task without commits as landed', async () => {
  const { worktree } = repo();

  const status = await checkMergeStatus(worktree, 'main');

  expect(status.already_landed).toBeUndefined();
});
