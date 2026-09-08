// Shared between the renderer (preamble text) and the main-process coordinator
// (hard enforcement in createTask) so the instructed and enforced limits can't drift.
export const MIN_COORDINATOR_CONCURRENT_TASKS = 1;
export const MAX_COORDINATOR_CONCURRENT_TASKS = 20;
export const DEFAULT_COORDINATOR_CONCURRENT_TASKS = 3;

export function clampCoordinatorConcurrentTasks(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COORDINATOR_CONCURRENT_TASKS;
  return Math.min(
    MAX_COORDINATOR_CONCURRENT_TASKS,
    Math.max(MIN_COORDINATOR_CONCURRENT_TASKS, Math.trunc(value)),
  );
}
