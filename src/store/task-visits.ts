import { createEffect, createRoot, on } from 'solid-js';
import { changesSinceVisit } from '../lib/task-visit';
import { store, setStore } from './core';

/** HEAD from the latest git status read; an errored read says nothing. */
function currentHeadSha(taskId: string): string | undefined {
  const git = store.taskGitStatus[taskId];
  return (!git?.error && git?.head_sha) || undefined;
}

function recordVisit(taskId: string | null): void {
  if (!taskId || !store.tasks[taskId]) return;
  const task = store.tasks[taskId];
  // A whole object: setStore merges, and stale fields must not survive.
  setStore('tasks', taskId, 'lastVisit', {
    at: Date.now(),
    headSha: currentHeadSha(taskId),
    codeFingerprint: task.codeFingerprint?.fingerprint ?? task.brief?.fingerprint,
  });
}

/**
 * Stamps a task's visit when it becomes active and again when it stops being
 * active, however that happens, so "since you looked" starts at leaving.
 * shortcut: no stamp on quit — the restored active task re-stamps on startup,
 * losing changes made while the app was closed; stamp on quit if that matters.
 * Returns a stop function.
 */
export function startTaskVisitTracker(): () => void {
  return createRoot((dispose) => {
    createEffect(
      on(
        () => store.activeTaskId,
        (id, previous) => {
          recordVisit(previous ?? null);
          recordVisit(id);
        },
      ),
    );
    return dispose;
  });
}

/** App-observed changes since the user last had the task open; none while it is open. */
export function getTaskChangesSinceVisit(taskId: string): string[] {
  const task = store.tasks[taskId];
  if (!task || store.activeTaskId === taskId) return [];
  return changesSinceVisit({
    visit: task.lastVisit,
    headSha: currentHeadSha(taskId),
    confidence: task.confidence,
    codeFingerprint: task.codeFingerprint,
    brief: task.brief,
    verificationRun: task.verificationRun,
    checks: task.evidence?.checks,
  });
}
