// Implementation lives in electron/shared so the main-process coordinator can
// enforce the same limits it re-exports here for the renderer.
export {
  MIN_COORDINATOR_CONCURRENT_TASKS,
  MAX_COORDINATOR_CONCURRENT_TASKS,
  DEFAULT_COORDINATOR_CONCURRENT_TASKS,
  clampCoordinatorConcurrentTasks,
} from '../../electron/shared/coordinator-limits';
