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
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
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

// A board where the app moved card A (local, unstaged) while the task branch
// committed its own board edits; see issue #337.
const BASE_BOARD = [
  '# Board',
  '',
  '## Todo',
  '',
  '- [ ] Card A',
  '  - [ ] first criterion',
  '  - [ ] second criterion',
  '',
  '- [ ] Card B',
  '  Notes on B',
  '',
  '## In Progress',
  '',
].join('\n');
const A_MOVED = [
  '# Board',
  '',
  '## Todo',
  '',
  '- [ ] Card B',
  '  Notes on B',
  '',
  '## In Progress',
  '',
  '- [ ] Card A',
  '  - [ ] first criterion',
  '  - [ ] second criterion',
  '  branch: task/a',
  '',
].join('\n');

const B_EXTENDED = (text: string) =>
  text.replace('  Notes on B\n', '  Notes on B\n  More from the task\n');
const crlf = (text: string) => text.replace(/\n/g, '\r\n');

/** `repo()` with BASE_BOARD committed, the branch committing `branchBoard`
 *  and the main checkout left with A_MOVED unstaged. `eol: 'crlf'` checks the
 *  board out with CRLF line endings, as Windows checkouts commonly do. */
function boardRepo(branchBoard: string, opts: { eol?: 'crlf' } = {}): string {
  const root = repo();
  const write = (text: string) =>
    fs.writeFileSync(path.join(root, 'KANBAN.md'), opts.eol ? crlf(text) : text);
  if (opts.eol) {
    fs.writeFileSync(path.join(root, '.gitattributes'), 'KANBAN.md text eol=crlf\n');
    run(root, ['add', '.gitattributes']);
  }
  write(BASE_BOARD);
  run(root, ['commit', '-qam', 'board']);
  run(root, ['branch', '-f', 'task/a']);
  run(root, ['checkout', '-q', 'task/a']);
  write(branchBoard);
  run(root, ['commit', '-qam', 'task edits board']);
  run(root, ['checkout', '-q', 'main']);
  write(A_MOVED);
  return root;
}

it('combines local board edits with board edits the task branch committed', async () => {
  const root = boardRepo(B_EXTENDED(BASE_BOARD));
  const result = await mergeTask(root, 'task/a', false, null, false, 'main');
  expect(result.warning).toBeUndefined();
  // Card A stays in its new column and card B keeps the branch's new line.
  expect(board(root)).toBe(B_EXTENDED(A_MOVED));
  expect(run(root, ['show', 'HEAD:KANBAN.md'])).toContain('More from the task');
});

it('combines board edits through a squash merge', async () => {
  const root = boardRepo(B_EXTENDED(BASE_BOARD));
  const result = await mergeTask(root, 'task/a', true, 'Squash', false, 'main');
  expect(result.warning).toBeUndefined();
  expect(board(root)).toBe(B_EXTENDED(A_MOVED));
});

it('combines board edits when landing from a task worktree (rebase, then ff-only)', async () => {
  const root = boardRepo(B_EXTENDED(BASE_BOARD));
  const worktree = path.join(root, '.worktrees', 'task', 'a');
  run(root, ['worktree', 'add', '-q', worktree, 'task/a']);
  const result = await mergeTask(root, 'task/a', false, null, false, 'main', worktree);
  expect(result.warning).toBeUndefined();
  expect(board(root)).toBe(B_EXTENDED(A_MOVED));
});

it('combines board edits in a checkout with CRLF line endings', async () => {
  const root = boardRepo(B_EXTENDED(BASE_BOARD), { eol: 'crlf' });
  const result = await mergeTask(root, 'task/a', false, null, false, 'main');
  expect(result.warning).toBeUndefined();
  expect(board(root)).toBe(crlf(B_EXTENDED(A_MOVED)));
});

it('keeps an untracked board and warns when the branch adds one', async () => {
  const root = repo();
  run(root, ['rm', '-q', 'KANBAN.md']);
  run(root, ['commit', '-qm', 'no board']);
  run(root, ['branch', '-f', 'task/a']);
  run(root, ['checkout', '-q', 'task/a']);
  fs.writeFileSync(path.join(root, 'KANBAN.md'), '# Board\n\n## Todo\n\n- [ ] From the task\n');
  run(root, ['add', 'KANBAN.md']);
  run(root, ['commit', '-qm', 'task adds board']);
  run(root, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(root, 'KANBAN.md'), LOCAL);
  const result = await mergeTask(root, 'task/a', false, null, false, 'main');
  expect(board(root)).toBe(LOCAL);
  expect(result.warning).toMatch(/KANBAN\.md/);
});

it('keeps the local board and warns when its edits clash with the branch', async () => {
  // The task ticks a criterion on the very card the app moved: the edits overlap.
  const root = boardRepo(BASE_BOARD.replace('[ ] first criterion', '[x] first criterion'));
  const result = await mergeTask(root, 'task/a', false, null, false, 'main');
  expect(board(root)).toBe(A_MOVED);
  expect(result.warning).toMatch(/KANBAN\.md/);
  expect(run(root, ['show', 'HEAD:KANBAN.md'])).toContain('[x] first criterion');
});

it('keeps the local board and warns when the branch deleted it', async () => {
  const root = repo();
  run(root, ['checkout', '-q', 'task/a']);
  run(root, ['rm', '-q', 'KANBAN.md']);
  run(root, ['commit', '-qm', 'task removes board']);
  run(root, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(root, 'KANBAN.md'), LOCAL);
  const result = await mergeTask(root, 'task/a', false, null, false, 'main');
  expect(board(root)).toBe(LOCAL);
  expect(result.warning).toMatch(/KANBAN\.md/);
});

// Root removes read-only folders, and Windows chmod does not make a folder
// read-only, so the failing removal cannot be set up there.
it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
  'names the board in the error when cleanup fails after a clashing merge',
  async () => {
    const root = boardRepo(BASE_BOARD.replace('[ ] first criterion', '[x] first criterion'));
    const worktree = path.join(root, '.worktrees', 'task', 'a');
    run(root, ['worktree', 'add', '-q', worktree, 'task/a']);
    // A read-only folder makes the worktree removal fail after the merge landed.
    const locked = path.join(worktree, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'file'), 'x');
    fs.chmodSync(locked, 0o555);
    try {
      await expect(mergeTask(root, 'task/a', false, null, true, 'main', worktree)).rejects.toThrow(
        /KANBAN\.md/,
      );
    } finally {
      fs.chmodSync(locked, 0o755);
    }
    expect(board(root)).toBe(A_MOVED);
  },
  20_000,
);

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
