import { store } from './core';
import { removeProject } from './projects';
import { disarmSpCompletion } from './superProductivity';
import { closeTask } from './tasks';

/**
 * Close every task that belongs to `projectId` (coordinators last so children
 * are gone first), then remove the project itself. If any close fails, the
 * project is kept so the user can retry without losing project metadata.
 */
export async function removeProjectWithTasks(projectId: string): Promise<void> {
  const taskIds = store.taskOrder.filter((tid) => store.tasks[tid]?.projectId === projectId);
  const collapsedTaskIds = store.collapsedTaskOrder.filter(
    (tid) => store.tasks[tid]?.projectId === projectId,
  );

  // Close tasks sequentially to avoid concurrent git operations on the same repo.
  // Must happen before removeProject() since closeTask needs the project path.
  const allIds = [...taskIds, ...collapsedTaskIds];
  const isCoordinator = (tid: string) => store.tasks[tid]?.coordinatorMode === true;
  const ordered = [...allIds.filter((tid) => !isCoordinator(tid)), ...allIds.filter(isCoordinator)];
  for (const tid of ordered) {
    // Removing a project never completes linked Super Productivity tasks, even
    // one whose own close failed earlier and left its completion armed for Retry.
    disarmSpCompletion(tid);
    // closeTask handles and stores its own errors, so this should not throw.
    await closeTask(tid);
  }

  const hasRemainingTasks = allIds.some((tid) => store.tasks[tid]?.projectId === projectId);
  if (hasRemainingTasks) return;

  removeProject(projectId);
}
