// Integration test against real git: Finish merges into a base checkout with
// uncommitted changes by setting them aside and putting them back afterwards.
import { it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { checkMergeStatus, mergeTask } from './git.js';

let base: string;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-dirty-target-it-'));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** A repo on main with a task worktree whose branch adds feature.txt. */
function repo(): { root: string; worktree: string } {
  const root = fs.mkdtempSync(path.join(base, 'repo-'));
  run(root, ['init', '-b', 'main']);
  run(root, ['config', 'user.email', 'test@test.local']);
  run(root, ['config', 'user.name', 'Test']);
  run(root, ['config', 'commit.gpgsign', 'false']);
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '/.worktrees/\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'notes\n');
  run(root, ['add', '.']);
  run(root, ['commit', '-m', 'initial']);
  const worktree = path.join(root, '.worktrees', 'task', 'a');
  run(root, ['worktree', 'add', '-b', 'task/a', worktree]);
  fs.writeFileSync(path.join(worktree, 'feature.txt'), 'work\n');
  fs.writeFileSync(path.join(worktree, 'README.md'), 'hello from the task\n');
  run(worktree, ['add', '.']);
  run(worktree, ['commit', '-m', 'work']);
  return { root, worktree };
}

const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8');

/** Staged, unstaged and untracked changes the task branch does not touch. */
function dirty(root: string): void {
  fs.writeFileSync(path.join(root, 'notes.txt'), 'staged\n');
  run(root, ['add', 'notes.txt']);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'staged then edited\n');
  fs.writeFileSync(path.join(root, 'scratch.txt'), 'untracked\n');
}

function expectDirtyKept(root: string): void {
  expect(read(root, 'notes.txt')).toBe('staged then edited\n');
  expect(read(root, 'scratch.txt')).toBe('untracked\n');
  expect(run(root, ['diff', '--cached', '--name-only']).trim()).toBe('notes.txt');
  expect(run(root, ['stash', 'list'])).toBe('');
}

it('still refuses a dirty base checkout unless allowed', async () => {
  const { root, worktree } = repo();
  dirty(root);
  await expect(mergeTask(root, 'task/a', false, null, false, 'main', worktree)).rejects.toThrow(
    /uncommitted changes/,
  );
  expectDirtyKept(root);
});

it('merges into a dirty base checkout and puts the changes back', async () => {
  const { root, worktree } = repo();
  dirty(root);
  const result = await mergeTask(
    root,
    'task/a',
    false,
    null,
    false,
    'main',
    worktree,
    undefined,
    true,
  );
  expect(result.warning).toBeUndefined();
  expect(read(root, 'feature.txt')).toBe('work\n');
  expect(() => run(root, ['merge-base', '--is-ancestor', 'task/a', 'main'])).not.toThrow();
  expectDirtyKept(root);
});

it('squash merges into a dirty base checkout and puts the changes back', async () => {
  const { root, worktree } = repo();
  dirty(root);
  await mergeTask(root, 'task/a', true, 'Squash', false, 'main', worktree, undefined, true);
  expect(run(root, ['log', '-1', '--format=%s']).trim()).toBe('Squash');
  expect(run(root, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort()).toEqual(
    ['README.md', 'feature.txt'],
  );
  expectDirtyKept(root);
});

it('keeps the changes when the merge fails', async () => {
  const { root, worktree } = repo();
  // Main moves README.md the other way: the merge conflicts and is aborted.
  fs.writeFileSync(path.join(root, 'README.md'), 'hello from main\n');
  run(root, ['commit', '-am', 'main edit']);
  dirty(root);
  const head = run(root, ['rev-parse', 'HEAD']);
  await expect(
    mergeTask(root, 'task/a', false, null, false, 'main', worktree, undefined, true),
  ).rejects.toThrow('Merge stopped on conflicts in README.md; nothing was merged.');
  expect(run(root, ['rev-parse', 'HEAD'])).toBe(head);
  expectDirtyKept(root);
});

it('refuses when the uncommitted changes touch files the merge changes', async () => {
  const { root, worktree } = repo();
  fs.writeFileSync(path.join(root, 'README.md'), 'local edit\n');
  const head = run(root, ['rev-parse', 'HEAD']);
  await expect(
    mergeTask(root, 'task/a', false, null, false, 'main', worktree, undefined, true),
  ).rejects.toThrow(/README\.md/);
  expect(run(root, ['rev-parse', 'HEAD'])).toBe(head);
  expect(read(root, 'README.md')).toBe('local edit\n');
  expect(run(root, ['stash', 'list'])).toBe('');
});

it('reports the base checkout changes and those the merge touches', async () => {
  const { root, worktree } = repo();
  dirty(root);
  fs.writeFileSync(path.join(root, 'README.md'), 'local edit\n');
  const status = await checkMergeStatus(worktree, 'main', root);
  expect(status.target_uncommitted).toEqual({
    path: root,
    files: ['README.md', 'notes.txt', 'scratch.txt'],
    overlap: ['README.md'],
  });
});

it('reports nothing for a clean base checkout', async () => {
  const { root, worktree } = repo();
  const status = await checkMergeStatus(worktree, 'main', root);
  expect(status.target_uncommitted).toBeUndefined();
});

it('sees overlap in paths git quotes', async () => {
  const { root, worktree } = repo();
  for (const name of ['my notes.txt', 'café.txt']) {
    fs.writeFileSync(path.join(worktree, name), 'task\n');
    fs.writeFileSync(path.join(root, name), 'local\n');
  }
  run(worktree, ['add', '.']);
  run(worktree, ['commit', '-m', 'quoted names']);
  const status = await checkMergeStatus(worktree, 'main', root);
  expect(status.target_uncommitted?.overlap.sort()).toEqual(['café.txt', 'my notes.txt']);
  await expect(
    mergeTask(root, 'task/a', false, null, false, 'main', worktree, undefined, true),
  ).rejects.toThrow(/my notes\.txt/);
});
