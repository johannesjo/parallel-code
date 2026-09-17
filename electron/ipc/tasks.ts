import { randomUUID } from 'crypto';
import { createWorktree, removeWorktree } from './git.js';
import { acquireEnv, releaseEnv, type PoolRepo } from './pool.js';
import { killAgent, notifyAgentListChanged } from './pty.js';
import { stopPlanWatcher } from './plans.js';
import { stopStepsWatcher } from './steps.js';

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
): Promise<{ id: string; branch_name: string; worktree_path: string }> {
  const id = randomUUID();
  const prefix = sanitizeBranchPrefix(branchPrefix);
  const branchName = `${prefix}/${slug(name)}-${id.slice(0, 6)}`;
  const worktree = await createWorktree(projectRoot, branchName, symlinkDirs, baseBranch);
  return {
    id,
    branch_name: worktree.branch,
    worktree_path: worktree.path,
  };
}

export interface CreatePoolTaskArgs {
  name: string;
  branchPrefix: string;
  envPaths: string[];
  members?: string[];
  liveTaskIds: string[];
}

/**
 * Create a task that leases a pooled environment.
 *
 * The branch name is derived here rather than in the renderer so a pool task
 * and a worktree task of the same name get the same branch: one slug rule, one
 * prefix rule, one place to change them.
 */
export async function createPoolTask(args: CreatePoolTaskArgs): Promise<{
  id: string;
  branch_name: string;
  env_path: string;
  repos: PoolRepo[];
}> {
  const id = randomUUID();
  const prefix = sanitizeBranchPrefix(args.branchPrefix);
  const branchName = `${prefix}/${slug(args.name)}-${id.slice(0, 6)}`;
  const { envPath, repos } = await acquireEnv({
    envPaths: args.envPaths,
    configuredMembers: args.members,
    taskId: id,
    taskName: args.name,
    branchName,
    liveTaskIds: args.liveTaskIds,
  });
  return { id, branch_name: branchName, env_path: envPath, repos };
}

export interface DeletePoolTaskOpts {
  taskId?: string;
  agentIds: string[];
  envPath: string;
  repos: PoolRepo[];
  /** Delete the task branch even where it holds commits. */
  force?: boolean;
}

/** Stop a pool task's agents and hand its environment back to the pool. */
export async function deletePoolTask(opts: DeletePoolTaskOpts): Promise<{
  keptBranches: string[];
  failures: { repo: string; reason: string }[];
}> {
  if (opts.taskId) stopPlanWatcher(opts.taskId);
  if (opts.taskId) stopStepsWatcher(opts.taskId);
  for (const agentId of opts.agentIds) {
    try {
      killAgent(agentId);
    } catch {
      /* already dead */
    }
  }
  const result = await releaseEnv({ envPath: opts.envPath, repos: opts.repos, force: opts.force });
  notifyAgentListChanged();
  return result;
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
  if (opts.taskId) stopStepsWatcher(opts.taskId);
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
