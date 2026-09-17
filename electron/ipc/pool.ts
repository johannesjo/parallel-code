import fs from 'fs';
import path from 'path';

import { atomicWriteFile } from '../mcp/atomic.js';
import { runGit } from './git.js';
import { discoverMembers, type PoolMemberSpec } from './pool-members.js';
import { alignMirrors, findSharedMirrors } from './pool-shared.js';

/**
 * Leasing for pooled workspaces.
 *
 * A pooled environment is not built per task: it is one of a fixed set of
 * ready checkouts that a task takes for its lifetime and gives back. That is
 * the whole reason the mode exists — the environments already hold installed
 * dependencies, initialised submodules and warm build caches, none of which
 * survive being copied and none of which a worktree gets for free.
 *
 * Because an environment is a real directory a person can also `cd` into, the
 * lease is written into it as well as held in app state. A colleague, a second
 * app instance, or the same user in a terminal can see that MRW3 is taken.
 */

/** Directory the pool keeps its own files in, inside each environment. */
const POOL_DIR = '.parallel-code';
const LEASE_FILE = 'lease.json';

export interface PoolLease {
  taskId: string;
  taskName: string;
  branchName: string;
  acquiredAt: number;
  /** Process that took the lease, for a human reading the file. */
  pid: number;
}

export interface PoolRepo {
  name: string;
  path: string;
  branchName: string;
  baseBranch: string;
}

/** Why an environment cannot be leased right now. */
export interface EnvBlocker {
  /** Member repository the problem is in, or undefined for the environment. */
  repo?: string;
  reason: string;
}

export interface EnvStatus {
  envPath: string;
  exists: boolean;
  members: PoolMemberSpec[];
  /** Declared by a manifest or the project, but not checked out yet. */
  missing: string[];
  lease: PoolLease | null;
  /** Empty when the environment is ready to lease. */
  blockers: EnvBlocker[];
}

function leasePath(envPath: string): string {
  return path.join(envPath, POOL_DIR, LEASE_FILE);
}

export function readLease(envPath: string): PoolLease | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(leasePath(envPath), 'utf8'));
  } catch {
    return null; // absent, unreadable, or half-written: treat as free
  }
  if (!raw || typeof raw !== 'object') return null;
  const lease = raw as Record<string, unknown>;
  if (typeof lease.taskId !== 'string' || !lease.taskId) return null;
  return {
    taskId: lease.taskId,
    taskName: typeof lease.taskName === 'string' ? lease.taskName : '',
    branchName: typeof lease.branchName === 'string' ? lease.branchName : '',
    acquiredAt: typeof lease.acquiredAt === 'number' ? lease.acquiredAt : 0,
    pid: typeof lease.pid === 'number' ? lease.pid : 0,
  };
}

async function writeLease(envPath: string, lease: PoolLease): Promise<void> {
  fs.mkdirSync(path.join(envPath, POOL_DIR), { recursive: true });
  await atomicWriteFile(leasePath(envPath), `${JSON.stringify(lease, null, 2)}\n`);
}

export function clearLease(envPath: string): void {
  try {
    fs.unlinkSync(leasePath(envPath));
  } catch {
    // Already gone — releasing twice is not an error.
  }
}

/**
 * A lease whose task no longer exists is stale: the app was killed, or the
 * task was removed while the environment was unreachable. Reclaiming it is
 * safe because the environment's own cleanliness is checked separately, and
 * refusing would strand the environment until someone deleted a file by hand.
 */
function isStaleLease(lease: PoolLease | null, liveTaskIds: ReadonlySet<string>): boolean {
  return lease !== null && !liveTaskIds.has(lease.taskId);
}

/** Whether a repository has uncommitted changes, including untracked files. */
async function isDirty(repoPath: string): Promise<boolean> {
  return (await runGit(repoPath, ['status', '--porcelain'])).length > 0;
}

/** Current branch, or null when HEAD is detached. */
async function currentBranch(repoPath: string): Promise<string | null> {
  const name = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return name === 'HEAD' ? null : name;
}

/**
 * Inspect one environment: what it holds, who has it, and what stands between
 * it and a lease.
 *
 * Blockers are collected rather than thrown on the first one, because the
 * point of the report is to tell someone everything they have to fix before
 * this environment is usable — three round trips to find three dirty repos is
 * the failure mode this avoids.
 *
 * A repository the manifest declares but that is not cloned is reported in
 * `missing` and is deliberately *not* a blocker. Manifests drift from the
 * checkouts beside them — they gain repositories nobody clones and lose ones
 * everybody has — and refusing an otherwise healthy environment over a line in
 * a file would make the pool unusable for the workspaces this mode exists for.
 */
export async function envStatus(
  envPath: string,
  configuredMembers: string[] | undefined,
  liveTaskIds: ReadonlySet<string>,
): Promise<EnvStatus> {
  if (!fs.existsSync(envPath)) {
    return {
      envPath,
      exists: false,
      members: [],
      missing: [],
      lease: null,
      blockers: [{ reason: 'Environment folder not found' }],
    };
  }

  const { members, missing } = discoverMembers(envPath, configuredMembers);
  const rawLease = readLease(envPath);
  const lease = isStaleLease(rawLease, liveTaskIds) ? null : rawLease;
  const blockers: EnvBlocker[] = [];

  if (lease) {
    blockers.push({ reason: `Leased by task "${lease.taskName || lease.taskId}"` });
  }
  if (members.length === 0) {
    blockers.push({ reason: 'No git repositories found in this environment' });
  }

  await Promise.all(
    members.map(async (member) => {
      const repoPath = path.join(envPath, member.name);
      try {
        if (await isDirty(repoPath)) {
          blockers.push({ repo: member.name, reason: 'Has uncommitted changes' });
        }
        if ((await currentBranch(repoPath)) === null) {
          blockers.push({ repo: member.name, reason: 'HEAD is detached' });
        }
      } catch (err) {
        blockers.push({ repo: member.name, reason: `Not readable by git: ${String(err)}` });
      }
    }),
  );

  return { envPath, exists: true, members, missing, lease, blockers };
}

export interface AcquireArgs {
  envPaths: string[];
  configuredMembers?: string[];
  taskId: string;
  taskName: string;
  branchName: string;
  /** Task ids the app still holds, so an abandoned lease can be reclaimed. */
  liveTaskIds: string[];
}

export interface AcquireResult {
  envPath: string;
  repos: PoolRepo[];
}

/**
 * Lease the first ready environment and branch every member repository in it.
 *
 * All member repos get the branch, not just the ones the task turns out to
 * touch: the platform convention is one branch name across every repository a
 * change spans, the branch is free to create when HEAD is already at base, and
 * an unused one is deleted again on release. Deciding up front also means the
 * agent never has to ask permission to start editing a second repo.
 *
 * Creation is all-or-nothing. A repository that refuses the branch rolls the
 * earlier ones back and frees the lease, because a half-branched environment
 * is worse than none: the next task would lease it, find it clean, and quietly
 * inherit the leftovers.
 */
export async function acquireEnv(args: AcquireArgs): Promise<AcquireResult> {
  const liveTaskIds = new Set(args.liveTaskIds);
  const reports: EnvStatus[] = [];

  for (const envPath of args.envPaths) {
    const status = await envStatus(envPath, args.configuredMembers, liveTaskIds);
    reports.push(status);
    if (status.blockers.length > 0) continue;

    await writeLease(envPath, {
      taskId: args.taskId,
      taskName: args.taskName,
      branchName: args.branchName,
      acquiredAt: Date.now(),
      pid: process.pid,
    });

    const created: PoolRepo[] = [];
    try {
      for (const member of status.members) {
        const repoPath = path.join(envPath, member.name);
        const baseBranch = (await currentBranch(repoPath)) ?? member.branch ?? 'HEAD';
        await runGit(repoPath, ['checkout', '-b', args.branchName]);
        created.push({
          name: member.name,
          path: repoPath,
          branchName: args.branchName,
          baseBranch,
        });
      }
    } catch (err) {
      await rollbackBranches(created);
      clearLease(envPath);
      throw new Error(
        `Could not branch every repository in ${envPath}, so nothing was changed: ${String(err)}`,
      );
    }
    // Every copy of a shared library goes onto its canonical repository's base
    // branch before the agent starts, so the application builds against the
    // code the change will be committed against. A copy that will not align is
    // reported rather than fatal: the task is still workable, it just cannot
    // carry that library's changes back cleanly.
    const alignment = await alignMirrors(await findSharedMirrors(created)).catch(() => []);
    for (const outcome of alignment) {
      if (outcome.error) console.warn(`Could not align ${outcome.mirror}:`, outcome.error);
    }

    return { envPath, repos: created };
  }

  throw new Error(describeUnavailable(reports));
}

async function rollbackBranches(repos: PoolRepo[]): Promise<void> {
  for (const repo of repos) {
    try {
      await runGit(repo.path, ['checkout', repo.baseBranch]);
      await runGit(repo.path, ['branch', '-D', repo.branchName]);
    } catch (err) {
      console.warn(`Could not roll back ${repo.branchName} in ${repo.path}:`, err);
    }
  }
}

/** One message naming why each environment was passed over. */
function describeUnavailable(reports: EnvStatus[]): string {
  if (reports.length === 0) return 'This project has no pool environments configured.';
  const lines = reports.map((report) => {
    const detail = report.blockers
      .map((blocker) => (blocker.repo ? `${blocker.repo}: ${blocker.reason}` : blocker.reason))
      .join('; ');
    return `  ${report.envPath} — ${detail || 'unavailable'}`;
  });
  return `No pool environment is free:\n${lines.join('\n')}`;
}

export interface ReleaseArgs {
  envPath: string;
  repos: PoolRepo[];
  /** Delete the task branch even where it holds commits. */
  force?: boolean;
}

export interface ReleaseResult {
  /** Repos whose task branch was kept because it still holds commits. */
  keptBranches: string[];
  /** Repos that could not be restored; the lease is dropped regardless. */
  failures: { repo: string; reason: string }[];
}

/**
 * Give an environment back: return every repository to the branch it was on,
 * drop task branches that never earned a commit, restore the submodule
 * checkouts to the pins of the base branch, and remove the lease.
 *
 * A branch with commits is kept unless the caller forces it. Losing work
 * silently is the one outcome worth more than a tidy environment, and the
 * readiness check will not be fooled: the next lease sees the environment is
 * clean and on base, which it is.
 */
export async function releaseEnv(args: ReleaseArgs): Promise<ReleaseResult> {
  const keptBranches: string[] = [];
  const failures: { repo: string; reason: string }[] = [];

  for (const repo of args.repos) {
    try {
      const onTaskBranch = (await currentBranch(repo.path)) === repo.branchName;
      if (onTaskBranch) await runGit(repo.path, ['checkout', repo.baseBranch]);

      const unmerged = await runGit(repo.path, [
        'log',
        `${repo.baseBranch}..${repo.branchName}`,
        '--oneline',
      ]).catch(() => '');
      if (unmerged && !args.force) {
        keptBranches.push(repo.name);
      } else {
        await runGit(repo.path, ['branch', '-D', repo.branchName]);
      }

      // Submodule pins move with the branch; without this the environment
      // stays on the task's pins and the next lease inherits them. `--force` is
      // required rather than tidy: a copy of a shared library was deliberately
      // moved off its pin at lease time and may hold edits, and a plain update
      // refuses to check out over those — which would leave the environment
      // dirty and unleasable.
      await runGit(repo.path, ['submodule', 'update', '--init', '--recursive', '--force']);
    } catch (err) {
      failures.push({ repo: repo.name, reason: String(err) });
    }
  }

  clearLease(args.envPath);
  return { keptBranches, failures };
}
