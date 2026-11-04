// Shared between the renderer (preamble text) and the main-process coordinator
// (hard enforcement in createTask) so the instructed and enforced limits can't drift.
export const MIN_COORDINATOR_CONCURRENT_TASKS = 1;
export const MAX_COORDINATOR_CONCURRENT_TASKS = 20;
export const DEFAULT_COORDINATOR_CONCURRENT_TASKS = 4;

export function clampCoordinatorConcurrentTasks(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COORDINATOR_CONCURRENT_TASKS;
  return Math.min(
    MAX_COORDINATOR_CONCURRENT_TASKS,
    Math.max(MIN_COORDINATOR_CONCURRENT_TASKS, Math.trunc(value)),
  );
}

// Independent tasks have no supervising parent; this caps how many one task may keep
// open, so a looping agent cannot start worktrees without end.
export const MIN_INDEPENDENT_TASKS_PER_CREATOR = 1;
export const MAX_INDEPENDENT_TASKS_PER_CREATOR = 100;
export const DEFAULT_INDEPENDENT_TASKS_PER_CREATOR = 12;

export function clampIndependentTasksPerCreator(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INDEPENDENT_TASKS_PER_CREATOR;
  return Math.min(
    MAX_INDEPENDENT_TASKS_PER_CREATOR,
    Math.max(MIN_INDEPENDENT_TASKS_PER_CREATOR, Math.trunc(value)),
  );
}
