// Integration test against real git: unstaged edits to the project's Kanban
// board (KANBAN.md), which the app makes as tasks move, survive every merge
// outcome, including the `reset --hard` that recovers a failed squash merge.
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
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-kanban-it-'));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** A repo with KANBAN.md committed on main and a task branch. */
function repo(): string {
  const root = fs.mkdtempSync(path.join(base, 'repo-'));
  run(root, ['init', '-b', 'main']);
  run(root, ['config', 'user.email', 'test@test.local']);
  run(root, ['config', 'user.name', 'Test']);
  run(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(root, 'KANBAN.md'), '# Board\n\n## Todo\n');
  run(root, ['add', '.']);
  run(root, ['commit', '-m', 'initial']);
  run(root, ['branch', 'task/a']);
  return root;
}

const LOCAL = '# Board\n\n## Todo\n\n- [ ] Edited on the board\n';
const board = (root: string) => fs.readFileSync(path.join(root, 'KANBAN.md'), 'utf8');

it('merges with unstaged board edits and keeps them', async () => {
  const root = repo();
  run(root, ['checkout', 'task/a']);
  fs.writeFileSync(path.join(root, 'feature.txt'), 'work\n');
  run(root, ['add', '.']);
  run(root, ['commit', '-m', 'work']);
  run(root, ['checkout', 'main']);
  fs.writeFileSync(path.join(root, 'KANBAN.md'), LOCAL);
  await mergeTask(root, 'task/a', true, 'Squash', false, 'main');
  expect(board(root)).toBe(LOCAL);
  expect(fs.existsSync(path.join(root, 'feature.txt'))).toBe(true);
});

it('keeps board edits when a squash merge fails and is reset', async () => {
  const root = repo();
  // Nothing new on the branch: the squash commit fails and the merge resets hard.
  fs.writeFileSync(path.join(root, 'KANBAN.md'), LOCAL);
  await expect(mergeTask(root, 'task/a', true, 'Squash', false, 'main')).rejects.toThrow();
  expect(board(root)).toBe(LOCAL);
});

it('keeps board edits when the task branch changed the board too', async () => {
  const root = repo();
  run(root, ['checkout', 'task/a']);
  fs.writeFileSync(path.join(root, 'KANBAN.md'), '# Board\n\n## Todo\n\n- [ ] From the task\n');
  run(root, ['commit', '-am', 'task edits board']);
  run(root, ['checkout', 'main']);
  fs.writeFileSync(path.join(root, 'KANBAN.md'), LOCAL);
  await mergeTask(root, 'task/a', true, 'Squash', false, 'main');
  // The local board wins; the task's version is in the commit.
  expect(board(root)).toBe(LOCAL);
  expect(run(root, ['show', 'HEAD:KANBAN.md'])).toContain('From the task');
});

it('keeps an untracked board through a merge', async () => {
  const root = repo();
  run(root, ['rm', '-q', 'KANBAN.md']);
  run(root, ['commit', '-m', 'no board']);
  run(root, ['branch', '-f', 'task/a']);
  run(root, ['checkout', 'task/a']);
  fs.writeFileSync(path.join(root, 'feature.txt'), 'work\n');
  run(root, ['add', '.']);
  run(root, ['commit', '-m', 'work']);
  run(root, ['checkout', 'main']);
  fs.writeFileSync(path.join(root, 'KANBAN.md'), LOCAL);
  await mergeTask(root, 'task/a', false, null, false, 'main');
  expect(board(root)).toBe(LOCAL);
});

it('still refuses to merge with staged board changes', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'KANBAN.md'), LOCAL);
  run(root, ['add', 'KANBAN.md']);
  await expect(mergeTask(root, 'task/a', true, 'Squash', false, 'main')).rejects.toThrow(
    /uncommitted changes/,
  );
  expect(board(root)).toBe(LOCAL);
});
