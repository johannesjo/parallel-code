import { batch } from 'solid-js';
import { store, setStore } from './core';

// Branch identity of a task. Lives outside tasks.ts so taskStatus.ts (which
// tasks.ts imports) can auto-adopt a diverged branch without an import cycle.

export function updateTaskBranch(taskId: string, branchName: string): void {
  const task = store.tasks[taskId];
  if (!task) return;
  const branchChanged = task.branchName !== branchName;
  batch(() => {
    setStore('tasks', taskId, 'branchName', branchName);
    // prUrl is only ever populated by branch-PR auto-detection, so dropping it
    // on rename is safe — the next detection pass will repopulate from the new
    // branch. If a user-editable PR URL is ever added, gate this on a flag.
    if (branchChanged && task.prUrl) {
      setStore('tasks', taskId, 'prUrl', undefined);
    }
    // A dismissed offer was about the old branch situation — let the next
    // divergence surface again.
    if (branchChanged && task.branchOfferDismissed) {
      setStore('tasks', taskId, 'branchOfferDismissed', undefined);
    }
    // An adoption notice names the old branch — stale once the branch moves on.
    if (branchChanged && task.branchAdoptedFrom) {
      setStore('tasks', taskId, 'branchAdoptedFrom', undefined);
    }
  });
}

/** Remember that the user declined adopting `branchName` as the task branch,
 *  so divergence detection stays quiet until the worktree moves elsewhere. */
function dismissBranchOffer(taskId: string, branchName: string): void {
  if (!store.tasks[taskId]) return;
  setStore('tasks', taskId, 'branchOfferDismissed', branchName);
}

/** Adopt the branch the agent switched the worktree to as the task branch and
 *  leave a notice for the banner (dismissable, undoable). */
export function adoptTaskBranch(taskId: string, branch: string): void {
  const task = store.tasks[taskId];
  if (!task || task.branchName === branch) return;
  const previousBranch = task.branchName;
  batch(() => {
    updateTaskBranch(taskId, branch);
    setStore('tasks', taskId, 'branchAdoptedFrom', previousBranch);
  });
}

/** Revert an auto-adoption: track the previous branch again and dismiss the
 *  adopted branch so detection doesn't immediately re-adopt it (the worktree
 *  is still on it). */
export function undoBranchAdoption(taskId: string): void {
  const task = store.tasks[taskId];
  const previousBranch = task?.branchAdoptedFrom;
  if (!task || !previousBranch) return;
  const adoptedBranch = task.branchName;
  batch(() => {
    updateTaskBranch(taskId, previousBranch);
    dismissBranchOffer(taskId, adoptedBranch);
  });
}

export function dismissBranchAdoptionNotice(taskId: string): void {
  if (!store.tasks[taskId]) return;
  setStore('tasks', taskId, 'branchAdoptedFrom', undefined);
}
