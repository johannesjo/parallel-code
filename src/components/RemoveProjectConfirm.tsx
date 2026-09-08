import { ConfirmDialog } from './ConfirmDialog';
import { store, removeProject, removeProjectWithTasks } from '../store/store';
import { getProjectTaskCount } from './project-remove-confirmation';
import { disposeDocumentAgentTask } from '../documents/agent-task';

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
          // A document project's agent sessions live outside the task lists.
          void disposeDocumentAgentTask(id);
          if (taskCount() > 0) {
            removeProjectWithTasks(id);
          } else {
            removeProject(id);
          }
        }
        props.onDone();
        props.onRemoved?.();
      }}
      onCancel={() => props.onDone()}
    />
  );
}
