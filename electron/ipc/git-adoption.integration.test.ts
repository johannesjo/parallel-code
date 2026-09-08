// Integration tests against real git: the branch-adoption lifecycle (agent
// switches the worktree's branch → user adopts it → merge/close). Guards the
// regression where close derived the worktree path from the ADOPTED branch
// name, leaking the real worktree and failing branch deletion.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getWorktreeStatus, removeWorktree, mergeTask } from './git.js';

let base: string;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const TASK_BRANCH = 'task/demo';
const AGENT_BRANCH = 'fix/issue-123-blabla';

/** Fresh repo with one commit on main and a worktree on task/demo. */
function makeRepo(name: string): { root: string; worktreePath: string } {
  const root = fs.mkdtempSync(path.join(base, `${name}-`));
  run(root, ['init', '-b', 'main']);
  run(root, ['config', 'user.email', 'test@test.local']);
  run(root, ['config', 'user.name', 'Test']);
  run(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  // Mirror what createWorktree seeds in a real project — without it the root
  // reads `?? .worktrees/` and the clean-tree guard refuses to merge.
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '/.worktrees/\n');
  run(root, ['add', '.']);
  run(root, ['commit', '-m', 'initial']);
  run(root, ['worktree', 'add', '-b', TASK_BRANCH, `.worktrees/${TASK_BRANCH}`]);
  return { root, worktreePath: path.join(root, '.worktrees', TASK_BRANCH) };
}

/** Simulate the agent: switch the worktree to its own branch and commit. */
function agentSwitchesBranch(worktreePath: string): void {
  run(worktreePath, ['checkout', '-b', AGENT_BRANCH]);
  fs.writeFileSync(path.join(worktreePath, 'fix.txt'), 'the fix\n');
  run(worktreePath, ['add', '.']);
  run(worktreePath, ['commit', '-m', 'agent fix']);
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'adoption-it-'));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('branch adoption against real git', () => {
  it('getWorktreeStatus reports the agent branch and resolved base', async () => {
    const { worktreePath } = makeRepo('status');
    agentSwitchesBranch(worktreePath);

    const status = await getWorktreeStatus(worktreePath);
    expect(status.current_branch).toBe(AGENT_BRANCH);
    expect(status.base_branch).toBe('main');
    expect(status.has_committed_changes).toBe(true);
  });

  it('getWorktreeStatus reports detached HEAD as null branch with base intact', async () => {
    const { worktreePath } = makeRepo('detached');
    run(worktreePath, ['checkout', '--detach']);

    const status = await getWorktreeStatus(worktreePath);
    expect(status.current_branch).toBeNull();
    expect(status.base_branch).toBe('main');
  });

  it('close after adoption: explicit worktreePath removes worktree and adopted branch', async () => {
    const { root, worktreePath } = makeRepo('close-fixed');
    agentSwitchesBranch(worktreePath);
    // Adoption: task.branchName is now AGENT_BRANCH, folder keeps its old name.
    await removeWorktree(root, AGENT_BRANCH, true, worktreePath);

    expect(fs.existsSync(worktreePath)).toBe(false);
    const branches = run(root, ['branch', '--list']);
    expect(branches).not.toContain(AGENT_BRANCH);
  });

  it('without explicit path, deriving from the adopted branch name leaks and throws', async () => {
    const { root, worktreePath } = makeRepo('close-broken');
    agentSwitchesBranch(worktreePath);
    await expect(removeWorktree(root, AGENT_BRANCH, true)).rejects.toThrow(
      /used by worktree|checked out/i,
    );
    // The real worktree is leaked.
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it('merge after adoption: guard passes, work lands on main, cleanup runs', async () => {
    const { root, worktreePath } = makeRepo('merge');
    agentSwitchesBranch(worktreePath);

    const result = await mergeTask(root, AGENT_BRANCH, false, null, true, 'main', worktreePath);
    expect(result.main_branch).toBe('main');

    const log = run(root, ['log', 'main', '--oneline']);
    expect(log).toContain('agent fix');
    expect(fs.existsSync(path.join(root, 'fix.txt'))).toBe(true);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(run(root, ['branch', '--list'])).not.toContain(AGENT_BRANCH);
  });

  it('merge WITHOUT adoption still refuses when the worktree is on another branch', async () => {
    const { root, worktreePath } = makeRepo('merge-guard');
    agentSwitchesBranch(worktreePath);
    // User declined adoption: task still expects TASK_BRANCH.
    await expect(
      mergeTask(root, TASK_BRANCH, false, null, false, 'main', worktreePath),
    ).rejects.toThrow(/Branch mismatch/);
  });
});
