// Integration test against real git: Finish merges a sub-task into a branch that
// is live in another worktree (the coordinator's), where `git checkout` is refused.
import { it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { mergeTask } from './git.js';

let base: string;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-worktree-it-'));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

it('merges into a target branch checked out in another worktree', async () => {
  const root = fs.mkdtempSync(path.join(base, 'repo-'));
  run(root, ['init', '-b', 'main']);
  run(root, ['config', 'user.email', 'test@test.local']);
  run(root, ['config', 'user.name', 'Test']);
  run(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '/.worktrees/\n');
  run(root, ['add', '.']);
  run(root, ['commit', '-m', 'initial']);
  run(root, ['worktree', 'add', '-b', 'task/coord', '.worktrees/task/coord']);
  run(root, ['worktree', 'add', '-b', 'task/child', '.worktrees/task/child', 'task/coord']);
  const coordPath = path.join(root, '.worktrees', 'task', 'coord');
  const childPath = path.join(root, '.worktrees', 'task', 'child');
  fs.writeFileSync(path.join(childPath, 'child.txt'), 'child work\n');
  run(childPath, ['add', '.']);
  run(childPath, ['commit', '-m', 'child work']);

  await mergeTask(root, 'task/child', false, null, false, 'task/coord', childPath);

  expect(run(root, ['log', 'task/coord', '--oneline'])).toContain('child work');
  expect(fs.existsSync(path.join(coordPath, 'child.txt'))).toBe(true);
  expect(run(root, ['branch', '--show-current']).trim()).toBe('main');
});
