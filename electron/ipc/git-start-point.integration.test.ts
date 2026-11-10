// Integration test against real git: new tasks start from the base's upstream
// after a fetch when the local base is merely behind it, and from the local
// base whenever that holds work the upstream lacks.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mergeTask } from './git.js';
import { resolveFreshStartPoint, taskStartPoint } from './git-start-point.js';

let base: string;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function configure(cwd: string): void {
  run(cwd, ['config', 'user.email', 'test@test.local']);
  run(cwd, ['config', 'user.name', 'Test']);
  run(cwd, ['config', 'commit.gpgsign', 'false']);
}

function commit(cwd: string, file: string, message: string): string {
  fs.writeFileSync(path.join(cwd, file), `${message}\n`);
  run(cwd, ['add', '.']);
  run(cwd, ['commit', '-m', message]);
  return run(cwd, ['rev-parse', 'HEAD']);
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'start-point-it-'));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** `repo` tracks `origin.git`; `other` is a second clone that pushes to it. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(base, 'case-'));
  const origin = path.join(dir, 'origin.git');
  const root = path.join(dir, 'repo');
  const other = path.join(dir, 'other');
  run(dir, ['init', '--bare', '-b', 'main', origin]);
  run(dir, ['init', '-b', 'main', root]);
  configure(root);
  commit(root, 'base.txt', 'initial');
  run(root, ['remote', 'add', 'origin', origin]);
  run(root, ['push', '-u', 'origin', 'main']);
  run(dir, ['clone', origin, other]);
  configure(other);
  return { dir, root, other };
}

it('fetches and starts from the upstream when local main is behind it', async () => {
  const { root, other } = fixture();
  const pushed = commit(other, 'remote.txt', 'remote work');
  run(other, ['push', 'origin', 'main']);

  // No fetch ran in `root`: only resolveFreshStartPoint can know `pushed`.
  expect(await resolveFreshStartPoint(root, 'main')).toBe(pushed);
});

it('keeps the local base when it is up to date', async () => {
  const { root } = fixture();
  expect(await resolveFreshStartPoint(root, 'main')).toBeUndefined();
});

it('keeps the local base when it has commits the upstream lacks', async () => {
  const { root, other } = fixture();
  commit(other, 'remote.txt', 'remote work');
  run(other, ['push', 'origin', 'main']);
  commit(root, 'local.txt', 'unpushed local merge');

  expect(await resolveFreshStartPoint(root, 'main')).toBeUndefined();
});

it('keeps the local base when it tracks no upstream', async () => {
  const { root } = fixture();
  run(root, ['branch', '--unset-upstream', 'main']);
  expect(await resolveFreshStartPoint(root, 'main')).toBeUndefined();
});

it('falls back to the last fetched upstream when the remote is unreachable', async () => {
  const { dir, root, other } = fixture();
  const pushed = commit(other, 'remote.txt', 'remote work');
  run(other, ['push', 'origin', 'main']);
  run(root, ['fetch', 'origin']);
  fs.renameSync(path.join(dir, 'origin.git'), path.join(dir, 'gone.git'));

  expect(await resolveFreshStartPoint(root, 'main')).toBe(pushed);
});

it('keeps the local base when its upstream is not origin/<same name>', async () => {
  const { root, other } = fixture();
  run(other, ['push', 'origin', 'main:develop']);
  commit(other, 'remote.txt', 'remote work');
  run(other, ['push', 'origin', 'main:develop']);
  run(root, ['fetch', 'origin']);
  run(root, ['branch', '-u', 'origin/develop', 'main']);

  // Diff bases only know origin/<base>; starting from origin/develop would
  // show its commits as the task's own changes.
  expect(await resolveFreshStartPoint(root, 'main')).toBeUndefined();
});

it('squash-merges only the task into a base that was behind its start point', async () => {
  const { root, other } = fixture();
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '/.worktrees/\n');
  const pushed = commit(other, 'remote.txt', 'remote work');
  run(other, ['push', 'origin', 'main']);
  const start = await resolveFreshStartPoint(root, 'main');
  const worktree = path.join(root, '.worktrees', 'task');
  run(root, ['worktree', 'add', '-b', 'task', worktree, start ?? 'main']);
  commit(worktree, 'work.txt', 'task work');

  await mergeTask(root, 'task', true, 'squash: task', false, 'main', worktree);

  // The upstream commit keeps its identity instead of being folded into the squash.
  expect(run(root, ['rev-parse', 'main~1'])).toBe(pushed);
  expect(run(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'main'])).toBe('work.txt');
});

it('neither fetches nor moves the start when the project opts out', async () => {
  const { root, other } = fixture();
  const before = run(root, ['rev-parse', 'origin/main']);
  commit(other, 'remote.txt', 'remote work');
  run(other, ['push', 'origin', 'main']);

  expect(await taskStartPoint(root, 'main', true)).toBeUndefined();
  expect(run(root, ['rev-parse', 'origin/main'])).toBe(before);
});

it('starts from HEAD when no base branch is given', async () => {
  const { root, other } = fixture();
  commit(other, 'remote.txt', 'remote work');
  run(other, ['push', 'origin', 'main']);
  expect(await taskStartPoint(root, undefined, false)).toBeUndefined();
});

it('starts from the fetched upstream by default', async () => {
  const { root, other } = fixture();
  const pushed = commit(other, 'remote.txt', 'remote work');
  run(other, ['push', 'origin', 'main']);
  expect(await taskStartPoint(root, 'main', false)).toBe(pushed);
});
