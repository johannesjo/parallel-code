// Implementation lives in electron/shared so the main-process coordinator can
// enforce the same limits it re-exports here for the renderer.
export {
  MIN_COORDINATOR_CONCURRENT_TASKS,
  MAX_COORDINATOR_CONCURRENT_TASKS,
  DEFAULT_COORDINATOR_CONCURRENT_TASKS,
  clampCoordinatorConcurrentTasks,
  MIN_INDEPENDENT_TASKS_PER_CREATOR,
  MAX_INDEPENDENT_TASKS_PER_CREATOR,
  DEFAULT_INDEPENDENT_TASKS_PER_CREATOR,
  clampIndependentTasksPerCreator,
} from '../../electron/shared/coordinator-limits';
