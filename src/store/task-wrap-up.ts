import { store } from './core';
import { taskPrsKnown } from './pr-checks';
import { getPrChecks, type PrChecksState } from './pr-checks-state';
import { taskPrs, taskPrsChecks } from './task-prs';
import { isTaskGitStatusFresh } from './taskStatus';
import type { Task } from './types';

export interface WrapUpInput {
  /** Every PR of the task, undefined while one is not reported yet. */
  prs: readonly (PrChecksState | undefined)[];
  /** False until a branch probe listed every PR: one in another repository may still turn up. */
  prsComplete: boolean;
  /** The task's own PR, whose head can be compared with the worktree's HEAD. */
  primaryPr: PrChecksState | undefined;
  /** Null while git status is unknown or stale. */
  git: { uncommitted: boolean; headSha: string | null | undefined } | null;
  finishItems: number;
}

/** `done`: nothing is left to keep, so the task can be closed without a look.
 *  `merged`: every PR of the task merged, as far as the probe can tell.
 *  `looseEnds`: what still stands between the task and that, in card words. */
export interface WrapUp {
  done: boolean;
  merged: boolean;
  looseEnds: string[];
}

/**
 * Done means every PR merged and nothing came after: no uncommitted changes and
 * no commit past the head GitHub merged. A task without a PR is never done here
 * — an untouched task looks the same, and a local merge is the Finish dialog's
 * to confirm.
 */
export function wrapUp(input: WrapUpInput): WrapUp {
  const allMerged =
    input.prsComplete && input.prs.length > 0 && input.prs.every((c) => c?.merged === true);
  // Recorded loose ends are "before you merge" notes: merging settled them, done
  // or skipped, and only the agent can clear the list, so they would never go.
  if (!allMerged) {
    const n = input.finishItems;
    return {
      done: false,
      merged: false,
      looseEnds: n === 0 ? [] : [n === 1 ? '1 loose end' : `${n} loose ends`],
    };
  }
  if (!input.git) return { done: false, merged: true, looseEnds: [] };
  const looseEnds: string[] = [];
  if (input.git.uncommitted) looseEnds.push('Uncommitted changes');
  const mergedHead = input.primaryPr?.headSha;
  // Without the merged head, a later commit would go unnoticed and be thrown away.
  // Only the task's own PR is compared; its HEAD is not an extra PR's repository,
  // so a task with PRs only in nested repositories is never vouched for.
  if (!mergedHead || !input.git.headSha) looseEnds.push('Later commits not checked');
  // Ahead (new commits) or behind (pulled elsewhere): either way not what merged.
  else if (mergedHead !== input.git.headSha) looseEnds.push('Differs from merged PR');
  return { done: looseEnds.length === 0, merged: true, looseEnds };
}

/** `wrapUp` for a task in the store. */
export function taskWrapUp(task: Task): WrapUp {
  const git = store.taskGitStatus[task.id];
  const hasPrimary = taskPrs(task).some((pr) => pr.watchId === task.id);
  return wrapUp({
    prs: taskPrsChecks(task),
    prsComplete: taskPrsKnown(task),
    primaryPr: hasPrimary ? getPrChecks(task.id) : undefined,
    git:
      git && isTaskGitStatusFresh(task.id)
        ? { uncommitted: git.has_uncommitted_changes, headSha: git.head_sha }
        : null,
    finishItems: task.finishItems?.items.length ?? 0,
  });
}
