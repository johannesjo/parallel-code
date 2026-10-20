import { ConfirmDialog } from './ConfirmDialog';
import { store, removeProject, removeProjectWithTasks } from '../store/store';
import { getProjectTaskCount } from './project-remove-confirmation';
import { disposeHiddenAgentTasks } from '../documents/agent-task';
import { errMessage, error as logError } from '../lib/log';
import { NOTIFICATION_ERROR_MS, showNotification } from '../store/notification';

/**
 * Hidden agents are disposed only after the project is gone: while it exists, a
 * mounted page may recreate a task deleted under it, leaving an orphan session.
 * A project kept because a task failed to close keeps its agents.
 */
export async function removeProjectAndHiddenAgents(projectId: string, closeTasks: boolean) {
  if (closeTasks) await removeProjectWithTasks(projectId);
  else removeProject(projectId);
  if (store.projects.some((p) => p.id === projectId)) return;
  await disposeHiddenAgentTasks(projectId);
}

interface RemoveProjectConfirmProps {
  /** Project to remove; null keeps the dialog closed. */
  projectId: string | null;
  /** Called when the dialog should close (confirm or cancel). */
  onDone: () => void;
  /** Called after removal has been initiated (e.g. to close a parent dialog). */
  onRemoved?: () => void;
}

/**
 * Confirmation dialog for removing a project, shared by every remove-project
 * entry point so they all warn about the tasks that will be closed.
 */
export function RemoveProjectConfirm(props: RemoveProjectConfirmProps) {
  const taskCount = () => (props.projectId ? getProjectTaskCount(store, props.projectId) : 0);

  return (
    <ConfirmDialog
      open={props.projectId !== null}
      title="Remove project?"
      message={
        taskCount() > 0
          ? `This project has ${taskCount()} open task(s). Removing it will also close all tasks, delete their worktrees and branches.`
          : 'Are you sure you want to remove this project?'
      }
      confirmLabel={taskCount() > 0 ? 'Remove all' : 'Remove'}
      danger
      onConfirm={() => {
        const id = props.projectId;
        if (id) {
          // Hidden agent sessions (document, GitHub) live outside the task lists.
          removeProjectAndHiddenAgents(id, taskCount() > 0).catch((err: unknown) => {
            logError('project', 'Removing project failed', err, { projectId: id });
            showNotification(`Could not remove project: ${errMessage(err)}`, {
              durationMs: NOTIFICATION_ERROR_MS,
            });
          });
        }
        props.onDone();
        props.onRemoved?.();
      }}
      onCancel={() => props.onDone()}
    />
  );
}
