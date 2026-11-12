// Integration test against real git: whether a merged PR is a task's own
// depends on how its branch came to hold the PR head, which only a real commit
// graph tells. GitHub's answers are mocked.
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { mockListOpenPrUrls, mockListPrsForHead, mockFetchPrHead } = vi.hoisted(() => ({
  mockListOpenPrUrls: vi.fn(),
  mockListPrsForHead: vi.fn(),
  mockFetchPrHead: vi.fn(),
}));

vi.mock('./pr-checks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pr-checks.js')>()),
  listOpenPrUrlsForBranch: mockListOpenPrUrls,
  listPrsForHead: mockListPrsForHead,
  fetchPrHead: mockFetchPrHead,
}));

import type { PrHead } from './pr-checks.js';
import { detectTaskPrs } from './task-prs.js';

const PR_URL = 'https://github.com/a/b/pull/9';
let base: string;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function commit(cwd: string, message: string): void {
  run(cwd, ['commit', '--allow-empty', '-m', message]);
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'task-prs-it-'));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mockListOpenPrUrls.mockResolvedValue([]);
  mockListPrsForHead.mockResolvedValue([]);
});

/** A repository on main, pushed to its origin. */
function repository(): string {
  const dir = fs.mkdtempSync(path.join(base, 'case-'));
  const origin = path.join(dir, 'origin.git');
  const root = path.join(dir, 'repo');
  run(dir, ['init', '--bare', '-b', 'main', origin]);
  run(dir, ['init', '-b', 'main', root]);
  run(root, ['config', 'user.email', 'test@test.local']);
  run(root, ['config', 'user.name', 'Test']);
  run(root, ['config', 'commit.gpgsign', 'false']);
  commit(root, 'initial');
  run(root, ['remote', 'add', 'origin', origin]);
  run(root, ['push', '-u', 'origin', 'main']);
  return root;
}

/** A task worktree on `branch`, created from main, with a commit of its own. */
function task(root: string, branch: string): string {
  const worktree = path.join(root, '.worktrees', branch.replace('/', '-'));
  run(root, ['worktree', 'add', '-b', branch, worktree, 'main']);
  commit(worktree, `${branch} work`);
  return worktree;
}

/** Pushes the task branch as `name`, which it then tracks. */
function pushAs(worktree: string, name: string): void {
  run(worktree, ['push', '-u', 'origin', `HEAD:refs/heads/${name}`]);
}

/** Merges the PR of the task's pushed branch `name` with a merge commit, as GitHub does, and pulls main. */
function mergePr(root: string, worktree: string, name: string): PrHead {
  const headRefOid = run(worktree, ['rev-parse', 'HEAD']);
  run(root, ['merge', '--no-ff', '-m', `Merge pull request #9 from ${name}`, headRefOid]);
  run(root, ['push', 'origin', 'main']);
  return {
    url: PR_URL,
    state: 'MERGED',
    headRefOid,
    headRefName: name,
    mergeCommitOid: run(root, ['rev-parse', 'main']),
  };
}

/** Closes a task as the app does: its worktree and local branch go, and the pushed branch too. */
function closeTask(root: string, worktree: string, branch: string, pushedAs: string): void {
  run(root, ['worktree', 'remove', '--force', worktree]);
  run(root, ['branch', '-D', branch]);
  run(root, ['push', 'origin', `:refs/heads/${pushedAs}`]);
}

it('adopts the merged PR of the branch the task pushed under another name', async () => {
  const root = repository();
  const worktree = task(root, 'task/x');
  pushAs(worktree, 'fix/x');
  mockListPrsForHead.mockResolvedValue([mergePr(root, worktree, 'fix/x')]);

  await expect(detectTaskPrs(worktree, 'task/x', { baseBranch: 'main' })).resolves.toEqual({
    url: PR_URL,
    extras: [],
  });
  expect(mockListPrsForHead).toHaveBeenCalledWith(worktree, 'fix/x');
});

it('still adopts it after the task merged main back in and went on', async () => {
  const root = repository();
  const worktree = task(root, 'task/x');
  pushAs(worktree, 'fix/x');
  const pr = mergePr(root, worktree, 'fix/x');
  commit(root, 'someone else’s work');
  commit(worktree, 'follow-up');
  run(worktree, ['merge', '--no-ff', '-m', 'Merge main', 'main']);
  mockListPrsForHead.mockResolvedValue([pr]);

  await expect(detectTaskPrs(worktree, 'task/x', { baseBranch: 'main' })).resolves.toEqual({
    url: PR_URL,
    extras: [],
  });
});

// The new task holds the older PR's head and its merge commit, both through main.
it('ignores a merged PR whose link a task created after the merge printed', async () => {
  const root = repository();
  const earlier = task(root, 'task/earlier');
  pushAs(earlier, 'fix/earlier');
  const pr = mergePr(root, earlier, 'fix/earlier');
  closeTask(root, earlier, 'task/earlier', 'fix/earlier');
  const worktree = task(root, 'task/x');
  mockFetchPrHead.mockResolvedValue(pr);

  await expect(
    detectTaskPrs(worktree, 'task/x', { printedPrUrl: PR_URL, baseBranch: 'main' }),
  ).resolves.toEqual({ url: null, extras: [] });
});

it('ignores an older merged PR of the branch name a later task pushes under', async () => {
  const root = repository();
  const earlier = task(root, 'task/earlier');
  pushAs(earlier, 'fix/typo');
  const pr = mergePr(root, earlier, 'fix/typo');
  closeTask(root, earlier, 'task/earlier', 'fix/typo');
  const worktree = task(root, 'task/x');
  pushAs(worktree, 'fix/typo');
  mockListPrsForHead.mockResolvedValue([pr]);

  await expect(detectTaskPrs(worktree, 'task/x', { baseBranch: 'main' })).resolves.toEqual({
    url: null,
    extras: [],
  });
  expect(mockListPrsForHead).toHaveBeenCalledWith(worktree, 'fix/typo');
});
