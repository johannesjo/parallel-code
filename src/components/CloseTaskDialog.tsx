import { Show, createResource } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { closeTask, getProject } from '../store/store';
import { ConfirmDialog } from './ConfirmDialog';
import { theme } from '../lib/theme';
import type { Task } from '../store/types';
import type { WorktreeStatus } from '../ipc/types';

interface CloseTaskDialogProps {
  open: boolean;
  task: Task;
  onDone: () => void;
}

export function CloseTaskDialog(props: CloseTaskDialogProps) {
  const [worktreeStatus] = createResource(
    () =>
      props.open && !props.task.directMode && !props.task.externalWorktree
        ? props.task.worktreePath
        : null,
    (path) => invoke<WorktreeStatus>(IPC.GetWorktreeStatus, { worktreePath: path }),
  );

  return (
    <ConfirmDialog
      open={props.open}
      title="Close Task"
      message={
        <div>
          <Show when={props.task.directMode}>
            <p style={{ margin: '0' }}>
              This will stop all running agents and shells for this task. No git operations will be
              performed.
            </p>
          </Show>
          <Show when={!props.task.directMode}>
            <Show
              when={
                !props.task.externalWorktree &&
                (worktreeStatus()?.has_uncommitted_changes ||
                  worktreeStatus()?.has_committed_changes)
              }
            >
              <div
                style={{
                  'margin-bottom': '12px',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '8px',
                }}
              >
                <Show when={worktreeStatus()?.has_uncommitted_changes}>
                  <div
                    style={{
                      'font-size': '12px',
                      color: theme.warning,
                      background: `color-mix(in srgb, ${theme.warning} 8%, transparent)`,
                      padding: '8px 12px',
                      'border-radius': '8px',
                      border: `1px solid color-mix(in srgb, ${theme.warning} 20%, transparent)`,
                      'font-weight': '600',
                    }}
                  >
                    Warning: There are uncommitted changes that will be permanently lost.
                  </div>
                </Show>
                <Show when={worktreeStatus()?.has_committed_changes}>
                  <div
                    style={{
                      'font-size': '12px',
                      color: theme.warning,
                      background: `color-mix(in srgb, ${theme.warning} 8%, transparent)`,
                      padding: '8px 12px',
                      'border-radius': '8px',
                      border: `1px solid color-mix(in srgb, ${theme.warning} 20%, transparent)`,
                      'font-weight': '600',
                    }}
                  >
                    Warning: This branch has commits that have not been merged into main.
                  </div>
                </Show>
              </div>
            </Show>
            {(() => {
              const project = getProject(props.task.projectId);
              const willDeleteBranch = props.task.externalWorktree
                ? false
                : (project?.deleteBranchOnClose ?? true);
              return (
                <>
                  <p style={{ margin: '0 0 8px' }}>
                    {props.task.externalWorktree
                      ? 'This will stop all running agents and shells and remove the imported task from Parallel Code. The existing git worktree will be left untouched.'
                      : willDeleteBranch
                        ? 'This action cannot be undone. The following will be permanently deleted:'
                        : 'The worktree will be removed but the branch will be kept:'}
                  </p>
                  <Show when={!props.task.externalWorktree}>
                    <ul
                      style={{
                        margin: '0',
                        'padding-left': '20px',
                        display: 'flex',
                        'flex-direction': 'column',
                        gap: '4px',
                      }}
                    >
                      <Show when={willDeleteBranch}>
                        <li>
                          Local feature branch <strong>{props.task.branchName}</strong>
                        </li>
                      </Show>
                      <li>
                        Worktree at <strong>{props.task.worktreePath}</strong>
                      </li>
                      <Show when={!willDeleteBranch}>
                        <li style={{ color: theme.fgMuted }}>
                          Branch <strong>{props.task.branchName}</strong> will be kept
                        </li>
                      </Show>
                    </ul>
                  </Show>
                </>
              );
            })()}
          </Show>
        </div>
      }
      confirmLabel={props.task.directMode || props.task.externalWorktree ? 'Close' : 'Delete'}
      danger={!props.task.directMode && !props.task.externalWorktree}
      onConfirm={() => {
        props.onDone();
        closeTask(props.task.id);
      }}
      onCancel={() => props.onDone()}
    />
  );
}
