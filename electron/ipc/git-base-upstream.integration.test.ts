// Integration test against real git: a local base whose unpushed commits
// reached origin in another form (e.g. folded into a squash merge) conflicts
// with a task branched from origin. The merge check says why and offers a reset.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkMergeStatus, mergeTask, resetBaseToUpstream } from './git.js';

let base: string;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function configure(cwd: string): void {
  run(cwd, ['config', 'user.email', 'test@test.local']);
  run(cwd, ['config', 'user.name', 'Test']);
  run(cwd, ['config', 'commit.gpgsign', 'false']);
}

function commit(cwd: string, file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
  run(cwd, ['add', '.']);
  run(cwd, ['commit', '-m', message]);
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'base-upstream-it-'));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/**
 * Local main adds guide.md unpushed; origin gets its own guide.md. The task
 * worktree branches from `from`, origin/main by default.
 */
function fixture(from = 'origin/main') {
  const dir = fs.mkdtempSync(path.join(base, 'case-'));
  const origin = path.join(dir, 'origin.git');
  const root = path.join(dir, 'repo');
  const other = path.join(dir, 'other');
  run(dir, ['init', '--bare', '-b', 'main', origin]);
  run(dir, ['init', '-b', 'main', root]);
  configure(root);
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '/.worktrees/\n');
  commit(root, 'base.txt', 'base\n', 'initial');
  run(root, ['remote', 'add', 'origin', origin]);
  run(root, ['push', '-u', 'origin', 'main']);

  run(dir, ['clone', origin, other]);
  configure(other);
  commit(other, 'guide.md', 'guide\nupstream wording\n', 'fix: something else, guide included');
  run(other, ['push', 'origin', 'main']);

  commit(root, 'guide.md', 'guide\nlocal wording\n', 'docs: add guide');
  run(root, ['fetch', 'origin']);

  const worktree = path.join(root, '.worktrees', 'task');
  run(root, ['worktree', 'add', '-b', 'task', worktree, from]);
  commit(worktree, 'work.txt', 'work\n', 'work');
  return { root, worktree };
}

it('reports local base commits the upstream and the task lack', async () => {
  const { root, worktree } = fixture();
  const status = await checkMergeStatus(worktree, 'main', root);
  expect(status.conflicting_files).toEqual(['guide.md']);
  expect(status.base_upstream).toEqual({
    upstream: 'origin/main',
    head: run(root, ['rev-parse', 'main']),
    behind: 1,
    local_count: 1,
    local_commits: [{ hash: expect.any(String), subject: 'docs: add guide' }],
    differing_files: ['guide.md'],
  });
});

it('reports nothing when the task already carries the local commits', async () => {
  const { root, worktree } = fixture('main');
  expect((await checkMergeStatus(worktree, 'main', root)).base_upstream).toBeUndefined();
});

it('names the base commits behind a conflict and whether origin has them', async () => {
  const { root, worktree } = fixture();
  await expect(mergeTask(root, 'task', false, null, false, 'main', worktree)).rejects.toThrow(
    /^Merge stopped on conflicts in guide\.md; nothing was merged\. main commits that changed them: [0-9a-f]{7,} docs: add guide \(not on origin\/main\)\.$/,
  );
});

it('resets the base to its upstream, after which the merge goes through', async () => {
  const { root, worktree } = fixture();
  const head = run(root, ['rev-parse', 'main']);
  await expect(resetBaseToUpstream(root, 'main', 'f'.repeat(40))).rejects.toThrow(
    'main changed since it was checked',
  );
  expect(run(root, ['rev-parse', 'main'])).toBe(head);

  fs.writeFileSync(path.join(root, 'scratch.txt'), 'untracked\n');
  expect(await resetBaseToUpstream(root, 'main', head)).toBe(head);
  expect(run(root, ['rev-parse', 'main'])).toBe(run(root, ['rev-parse', 'origin/main']));
  expect(fs.readFileSync(path.join(root, 'guide.md'), 'utf8')).toBe('guide\nupstream wording\n');
  expect(fs.readFileSync(path.join(root, 'scratch.txt'), 'utf8')).toBe('untracked\n');

  expect((await checkMergeStatus(worktree, 'main', root)).base_upstream).toBeUndefined();
  await mergeTask(root, 'task', false, null, false, 'main', worktree, undefined, true);
  expect(fs.existsSync(path.join(root, 'work.txt'))).toBe(true);
});

it('moves the branch ref when the base is not checked out', async () => {
  const { root, worktree } = fixture();
  const head = run(root, ['rev-parse', 'main']);
  run(root, ['checkout', '--detach']);
  await resetBaseToUpstream(root, 'main', head);
  expect(run(root, ['rev-parse', 'main'])).toBe(run(root, ['rev-parse', 'origin/main']));
  expect(run(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('task');
});
