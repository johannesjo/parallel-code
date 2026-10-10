import { randomUUID } from 'crypto';
import { createWorktree, removeWorktree, worktreePathFor } from './git.js';
import { killAgent, notifyAgentListChanged } from './pty.js';
import { stopPlanWatcher } from './plans.js';
import { recordWorktreeIntent } from './worktree-intents.js';
import { localBranchExists, resolvePrCheckout } from '../github/pr-checkout.js';
import type { CreatePrTaskResult } from './shared-types.js';

const MAX_SLUG_LEN = 72;

function slug(name: string): string {
  let result = '';
  let prevWasHyphen = false;
  for (const c of name.toLowerCase()) {
    if (result.length >= MAX_SLUG_LEN) break;
    if (/[a-z0-9]/.test(c)) {
      result += c;
      prevWasHyphen = false;
    } else if (!prevWasHyphen) {
      result += '-';
      prevWasHyphen = true;
    }
  }
  return result.replace(/^-+|-+$/g, '');
}

function sanitizeBranchPrefix(prefix: string): string {
  const parts = prefix
    .split('/')
    .map(slug)
    .filter((p) => p.length > 0);
  return parts.length === 0 ? 'task' : parts.join('/');
}

export async function createTask(
  name: string,
  projectRoot: string,
  symlinkDirs: string[],
  branchPrefix: string,
  baseBranch?: string,
  snapshotCommit?: string,
): Promise<{ id: string; branch_name: string; worktree_path: string }> {
  const id = randomUUID();
  const prefix = sanitizeBranchPrefix(branchPrefix);
  const branchName = `${prefix}/${slug(name)}-${id.slice(0, 6)}`;
  // Before provisioning, so a crash before the task is saved leaves a trace.
  recordWorktreeIntent({
    worktreePath: worktreePathFor(projectRoot, branchName),
    branchName,
    projectRoot,
  });
  const worktree = await createWorktree(
    projectRoot,
    branchName,
    symlinkDirs,
    snapshotCommit ?? baseBranch,
  );
  return {
    id,
    branch_name: worktree.branch,
    worktree_path: worktree.path,
  };
}

/** Creates a task worktree on an open pull request's head commit. */
export async function createPrTask(
  projectRoot: string,
  prNumber: number,
  symlinkDirs: string[],
  branchPrefix: string,
): Promise<CreatePrTaskResult> {
  const pr = await resolvePrCheckout(projectRoot, prNumber);
  const id = randomUUID();
  // Same-repo PRs reuse the PR branch so a push updates the PR. Otherwise the
  // task gets its own name, and pushing creates a separate branch on origin:
  // fork PRs (pushing to them needs the fork as a remote), PRs fetched from a
  // remote other than origin (a push would land in origin, not the PR's repo),
  // PR branches that already exist locally (they may hold unpushed work), and
  // names we reject.
  const head = pr.isCrossRepository || pr.remote !== 'origin' ? null : pr.headRefName;
  const reuseHead = head !== null && !(await localBranchExists(projectRoot, head));
  const branchName = reuseHead
    ? head
    : `${sanitizeBranchPrefix(branchPrefix)}/pr-${prNumber}-${id.slice(0, 6)}`;
  recordWorktreeIntent({
    worktreePath: worktreePathFor(projectRoot, branchName),
    branchName,
    projectRoot,
  });
  const worktree = await createWorktree(projectRoot, branchName, symlinkDirs, pr.headSha);
  return {
    id,
    branch_name: worktree.branch,
    worktree_path: worktree.path,
    pr_url: pr.url,
    // Diffs and merges compare against a local branch; empty lets the caller
    // fall back to its own base when the PR base isn't checked out locally.
    base_branch: (await localBranchExists(projectRoot, pr.baseRefName)) ? pr.baseRefName : '',
  };
}

interface DeleteTaskOpts {
  taskId?: string;
  agentIds: string[];
  branchName: string;
  deleteBranch: boolean;
  projectRoot: string;
  /** Real worktree location; the folder keeps its original branch-derived
   *  name even after the task adopts a branch the agent switched to. */
  worktreePath?: string;
}

export async function deleteTask(opts: DeleteTaskOpts): Promise<void> {
  if (opts.taskId) stopPlanWatcher(opts.taskId);
  for (const agentId of opts.agentIds) {
    try {
      killAgent(agentId);
    } catch {
      /* already dead */
    }
  }
  await removeWorktree(opts.projectRoot, opts.branchName, opts.deleteBranch, opts.worktreePath);
  notifyAgentListChanged();
}
