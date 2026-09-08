import { validateBranchName } from '../../electron/mcp/validation';
import type { Task, TaskGitStatusSnapshot } from '../store/types';

/** Divergence between the branch a task tracks and what its worktree is on. */
export type BranchDivergence =
  | {
      kind: 'switched';
      /** Branch the worktree is actually on. */
      branch: string;
      /** False when the worktree sits on the base branch (or the base is
       *  unknown) — adopting the base as the task branch would make merge a
       *  self-merge and close-time cleanup would try to delete it. */
      adoptable: boolean;
    }
  | { kind: 'detached' };

export type DivergenceTaskInput = Pick<
  Task,
  'branchName' | 'baseBranch' | 'gitIsolation' | 'branchOfferDismissed'
>;

type DivergenceSnapshotInput = Pick<
  TaskGitStatusSnapshot,
  'current_branch' | 'base_branch' | 'refreshedAt' | 'stale' | 'error'
>;

function isValidBranchName(branch: string): boolean {
  try {
    validateBranchName(branch);
    return true;
  } catch {
    return false;
  }
}

/** Whether adopting `branch` as the task branch is safe. Adopting the base
 *  branch would make merge a self-merge and close-time cleanup would delete
 *  the base; an unknown base is treated as not-safe for the same reason.
 *  Names the IPC validator rejects (git allows chars like `;` and `$` that it
 *  refuses) are not adoptable either — adopting one would wedge every
 *  branch-parameterized IPC call, including task close. */
export function isAdoptableBranch(branch: string, base: string | null | undefined): boolean {
  return base !== null && base !== undefined && branch !== base && isValidBranchName(branch);
}

/**
 * Detect whether an agent moved the worktree off the task's branch.
 *
 * Only meaningful for worktree-isolated tasks: in 'direct' mode the
 * "worktree" is the user's own checkout where switching branches is normal,
 * and 'none' has no git state at all.
 */
export function detectBranchDivergence(
  task: DivergenceTaskInput,
  snapshot: DivergenceSnapshotInput | undefined,
): BranchDivergence | null {
  if (task.gitIsolation !== 'worktree') return null;
  if (!snapshot || snapshot.error || snapshot.stale || snapshot.refreshedAt === 0) return null;

  const current = snapshot.current_branch;
  if (current === null) {
    // null current_branch is either a detached HEAD or an unreadable worktree.
    // base_branch resolves for any readable repo, so use it to tell them
    // apart and stay silent when the worktree itself is gone.
    return snapshot.base_branch ? { kind: 'detached' } : null;
  }
  if (current === task.branchName) return null;
  if (task.branchOfferDismissed === current) return null;

  const base = task.baseBranch ?? snapshot.base_branch;
  return { kind: 'switched', branch: current, adoptable: isAdoptableBranch(current, base) };
}

export interface DivergenceObservation {
  key: string;
  /** refreshedAt of the first snapshot that showed this divergence. */
  firstSeenAt: number;
}

export function divergenceKey(divergence: BranchDivergence): string {
  return divergence.kind === 'switched' ? `switched:${divergence.branch}` : 'detached';
}

/**
 * Debounce divergence across polls: agents hop through checkouts mid-work
 * (rebases detach HEAD transiently), so a divergence only counts as confirmed
 * once a snapshot newer than `firstSeenAt` still shows the same key.
 */
export function trackDivergence(
  prev: DivergenceObservation | null,
  divergence: BranchDivergence | null,
  refreshedAt: number,
): DivergenceObservation | null {
  if (!divergence) return null;
  const key = divergenceKey(divergence);
  return prev?.key === key ? prev : { key, firstSeenAt: refreshedAt };
}

/** Structural equality so memos don't propagate identical divergences. */
export function sameDivergence(a: BranchDivergence | null, b: BranchDivergence | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind !== 'switched' || b.kind !== 'switched') return true;
  return a.branch === b.branch && a.adoptable === b.adoptable;
}
