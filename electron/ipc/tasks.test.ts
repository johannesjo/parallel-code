import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createWorktree: vi.fn(),
  resolvePrCheckout: vi.fn(),
  localBranchExists: vi.fn(),
}));

vi.mock('./git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./git.js')>()),
  createWorktree: mocks.createWorktree,
}));
vi.mock('./pty.js', () => ({ killAgent: vi.fn(), notifyAgentListChanged: vi.fn() }));
vi.mock('./plans.js', () => ({ stopPlanWatcher: vi.fn() }));
vi.mock('../github/pr-checkout.js', () => ({
  resolvePrCheckout: mocks.resolvePrCheckout,
  localBranchExists: mocks.localBranchExists,
}));

import { createPrTask, createTask } from './tasks.js';
import { reconcileWorktreeIntents } from './worktree-intents.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('createTask', () => {
  it('journals the worktree before provisioning it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-tasks-'));
    tempDirs.push(root);
    const journal = path.join(root, 'worktree-intents.json');
    const projectRoot = path.join(root, 'repo');
    reconcileWorktreeIntents(journal, null);

    let journaledAtProvision: unknown[] = [];
    mocks.createWorktree.mockImplementation(async (repoRoot: string, branch: string) => {
      journaledAtProvision = JSON.parse(fs.readFileSync(journal, 'utf8')).intents;
      return { path: `${repoRoot}/.worktrees/${branch}`, branch };
    });

    const task = await createTask('Fix login', projectRoot, [], 'task');

    expect(journaledAtProvision).toEqual([
      expect.objectContaining({
        worktreePath: task.worktree_path,
        branchName: task.branch_name,
        projectRoot,
      }),
    ]);
  });
});

describe('createPrTask', () => {
  const pr = {
    headSha: 'abc123',
    headRefName: 'feature/login',
    baseRefName: 'develop',
    isCrossRepository: false,
    url: 'https://github.com/o/r/pull/5',
    remote: 'origin',
  };

  function setup(
    opts: {
      pr?: Partial<Omit<typeof pr, 'headRefName'>> & { headRefName?: string | null };
      localBranches?: string[];
    } = {},
  ): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-pr-task-'));
    tempDirs.push(root);
    reconcileWorktreeIntents(path.join(root, 'worktree-intents.json'), null);
    mocks.resolvePrCheckout.mockResolvedValue({ ...pr, ...opts.pr });
    mocks.localBranchExists.mockImplementation(async (_root: string, branch: string) =>
      (opts.localBranches ?? ['develop']).includes(branch),
    );
    mocks.createWorktree.mockImplementation(async (repoRoot: string, branch: string) => ({
      path: `${repoRoot}/.worktrees/${branch}`,
      branch,
    }));
    return path.join(root, 'repo');
  }

  afterEach(() => {
    mocks.createWorktree.mockReset();
  });

  it('reuses the PR branch for same-repo PRs so a push updates the PR', async () => {
    const projectRoot = setup();
    const task = await createPrTask(projectRoot, 5, [], 'task');
    expect(mocks.createWorktree).toHaveBeenCalledWith(projectRoot, 'feature/login', [], 'abc123');
    expect(task).toMatchObject({
      branch_name: 'feature/login',
      pr_url: pr.url,
      base_branch: 'develop',
    });
  });

  it('gives fork PRs a prefixed local branch', async () => {
    const projectRoot = setup({ pr: { isCrossRepository: true } });
    const task = await createPrTask(projectRoot, 5, [], 'Agent Work');
    expect(task.branch_name).toMatch(/^agent-work\/pr-5-[0-9a-f]{6}$/);
  });

  it('gives PRs fetched from a non-origin remote a prefixed branch', async () => {
    const projectRoot = setup({ pr: { remote: 'upstream' } });
    const task = await createPrTask(projectRoot, 5, [], 'task');
    expect(task.branch_name).toMatch(/^task\/pr-5-[0-9a-f]{6}$/);
  });

  it('leaves the base empty when the PR base is not a local branch', async () => {
    const projectRoot = setup({ localBranches: [] });
    const task = await createPrTask(projectRoot, 5, [], 'task');
    expect(task.base_branch).toBe('');
  });

  it('uses a prefixed branch when the PR branch already exists locally', async () => {
    const projectRoot = setup({ localBranches: ['develop', 'feature/login'] });
    const task = await createPrTask(projectRoot, 5, [], 'task');
    expect(task.branch_name).toMatch(/^task\/pr-5-[0-9a-f]{6}$/);
  });

  it('uses a prefixed branch when the PR branch name is not usable locally', async () => {
    const projectRoot = setup({ pr: { headRefName: null } });
    const task = await createPrTask(projectRoot, 5, [], 'task');
    expect(task.branch_name).toMatch(/^task\/pr-5-[0-9a-f]{6}$/);
  });
});
