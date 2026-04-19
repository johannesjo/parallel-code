import { Show, For, createSignal, createResource, createEffect } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, mergeTask, sendPrompt, updateTaskBranch } from '../store/store';
import { ConfirmDialog } from './ConfirmDialog';
import { ChangedFilesList } from './ChangedFilesList';
import { theme, bannerStyle } from '../lib/theme';
import type { Task } from '../store/types';
import type { ChangedFile, MergeStatus, WorktreeStatus } from '../ipc/types';

interface MergeDialogProps {
  open: boolean;
  task: Task;
  initialCleanup: boolean;
  onDone: () => void;
  onDiffFileClick: (file: ChangedFile) => void;
}

export function MergeDialog(props: MergeDialogProps) {
  const [mergeError, setMergeError] = createSignal('');
  const [merging, setMerging] = createSignal(false);
  const [squash, setSquash] = createSignal(false);
  const [cleanupAfterMerge, setCleanupAfterMerge] = createSignal(false);
  const [squashMessage, setSquashMessage] = createSignal('');
  const [rebasing, setRebasing] = createSignal(false);
  const [rebaseError, setRebaseError] = createSignal('');
  const [rebaseSuccess, setRebaseSuccess] = createSignal(false);

  const resourceSource = () =>
    props.open ? { path: props.task.worktreePath, baseBranch: props.task.baseBranch } : null;
  const [branchLog, { refetch: refetchBranchLog }] = createResource(resourceSource, (src) =>
    invoke<string>(IPC.GetBranchLog, { worktreePath: src.path, baseBranch: src.baseBranch }),
  );
  const [worktreeStatus, { refetch: refetchWorktreeStatus }] = createResource(
    resourceSource,
    (src) =>
      invoke<WorktreeStatus>(IPC.GetWorktreeStatus, {
        worktreePath: src.path,
        baseBranch: src.baseBranch,
      }),
  );
  const [mergeStatus, { refetch: refetchMergeStatus }] = createResource(resourceSource, (src) =>
    invoke<MergeStatus>(IPC.CheckMergeStatus, {
      worktreePath: src.path,
      baseBranch: src.baseBranch,
    }),
  );

  const hasConflicts = () => (mergeStatus()?.conflicting_files.length ?? 0) > 0;
  const hasCommittedChangesToMerge = () => worktreeStatus()?.has_committed_changes ?? false;
  const hasBranchMismatch = () => {
    const status = worktreeStatus();
    if (!status) return false;
    const current = status.current_branch;
    // null means detached HEAD — also a mismatch
    return current === null || current !== props.task.branchName;
  };

  createEffect(() => {
    if (props.open) {
      setCleanupAfterMerge(props.initialCleanup);
      setSquash(false);
      setSquashMessage('');
      setMergeError('');
      setRebaseError('');
      setRebaseSuccess(false);
      setMerging(false);
      setRebasing(false);
      // Force fresh data on every open — covers edge cases where
      // createResource source tracking alone misses a refresh
      // (e.g. external rebase by AI agent while dialog was closed).
      refetchBranchLog();
      refetchMergeStatus();
      refetchWorktreeStatus();
    }
  });

  return (
    <ConfirmDialog
      open={props.open}
      title="Merge into Main"
      width="520px"
      autoFocusCancel
      message={
        <div>
          <Show when={hasBranchMismatch()}>
            <div
              style={{
                ...bannerStyle(theme.error),
                'margin-bottom': '12px',
                'font-size': '13px',
              }}
            >
              <Show when={worktreeStatus()?.current_branch === null}>
                <div style={{ 'font-weight': '600' }}>
                  Worktree has a detached HEAD — merging '{props.task.branchName}' would discard
                  work.
                </div>
              </Show>
              <Show when={worktreeStatus()?.current_branch !== null}>
                <div style={{ 'font-weight': '600' }}>
                  The worktree is on '{worktreeStatus()?.current_branch}' but this task tracks '
                  {props.task.branchName}'.
                </div>
                <div
                  style={{
                    'margin-top': '8px',
                    display: 'flex',
                    'align-items': 'center',
                    gap: '8px',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      const current = worktreeStatus()?.current_branch;
                      if (current) {
                        updateTaskBranch(props.task.id, current);
                        refetchBranchLog();
                        refetchMergeStatus();
                        refetchWorktreeStatus();
                      }
                    }}
                    style={{
                      padding: '4px 12px',
                      background: theme.bgInput,
                      border: `1px solid ${theme.border}`,
                      'border-radius': '6px',
                      color: theme.fg,
                      cursor: 'pointer',
                      'font-size': '13px',
                    }}
                  >
                    Use '{worktreeStatus()?.current_branch}'
                  </button>
                </div>
              </Show>
            </div>
          </Show>
          <Show when={worktreeStatus()?.has_uncommitted_changes}>
            <div
              style={{
                ...bannerStyle(theme.warning),
                'margin-bottom': '12px',
                'font-size': '13px',
                'font-weight': '600',
              }}
            >
              Warning: You have uncommitted changes that will NOT be included in this merge.
            </div>
          </Show>
          <Show when={!worktreeStatus.loading && !hasCommittedChangesToMerge()}>
            <div
              style={{
                ...bannerStyle(theme.warning),
                'margin-bottom': '12px',
                'font-size': '13px',
                'font-weight': '600',
              }}
            >
              Nothing to merge: this branch has no committed changes compared to main/master.
            </div>
          </Show>
          <Show when={mergeStatus.loading}>
            <div
              style={{
                'margin-bottom': '12px',
                'font-size': '13px',
                color: theme.fgMuted,
                padding: '8px 12px',
                'border-radius': '8px',
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
              }}
            >
              Checking for conflicts with main...
            </div>
          </Show>
          <Show when={!mergeStatus.loading && mergeStatus()}>
            {(status) => (
              <Show when={status().main_ahead_count > 0}>
                <div
                  style={{
                    ...bannerStyle(hasConflicts() ? theme.error : theme.warning),
                    'margin-bottom': '12px',
                    'font-size': '13px',
                    'font-weight': '600',
                  }}
                >
                  <Show when={!hasConflicts()}>
                    Main has {status().main_ahead_count} new commit
                    {status().main_ahead_count > 1 ? 's' : ''}. Rebase onto main first.
                  </Show>
                  <Show when={hasConflicts()}>
                    <div>
                      Conflicts detected with main ({status().conflicting_files.length} file
                      {status().conflicting_files.length > 1 ? 's' : ''}):
                    </div>
                    <ul style={{ margin: '4px 0 0', 'padding-left': '20px', 'font-weight': '400' }}>
                      <For each={status().conflicting_files}>{(f) => <li>{f}</li>}</For>
                    </ul>
                    <div style={{ 'margin-top': '4px', 'font-weight': '400' }}>
                      Rebase onto main to resolve conflicts.
                    </div>
                  </Show>
                </div>
                <div
                  style={{
                    'margin-bottom': '12px',
                    display: 'flex',
                    'align-items': 'center',
                    gap: '8px',
                  }}
                >
                  <button
                    type="button"
                    disabled={rebasing() || worktreeStatus()?.has_uncommitted_changes}
                    onClick={async () => {
                      setRebasing(true);
                      setRebaseError('');
                      setRebaseSuccess(false);
                      try {
                        await invoke(IPC.RebaseTask, {
                          worktreePath: props.task.worktreePath,
                          baseBranch: props.task.baseBranch,
                        });
                        setRebaseSuccess(true);
                        refetchMergeStatus();
                        refetchBranchLog();
                        refetchWorktreeStatus();
                      } catch (err) {
                        setRebaseError(String(err));
                      } finally {
                        setRebasing(false);
                      }
                    }}
                    title={
                      worktreeStatus()?.has_uncommitted_changes
                        ? 'Commit or stash changes before rebasing'
                        : 'Rebase onto main'
                    }
                    style={{
                      padding: '6px 14px',
                      background: theme.bgInput,
                      border: `1px solid ${theme.border}`,
                      'border-radius': '8px',
                      color: theme.fg,
                      cursor:
                        rebasing() || worktreeStatus()?.has_uncommitted_changes
                          ? 'not-allowed'
                          : 'pointer',
                      'font-size': '13px',
                      opacity:
                        rebasing() || worktreeStatus()?.has_uncommitted_changes ? '0.5' : '1',
                    }}
                  >
                    {rebasing() ? 'Rebasing...' : 'Rebase onto main'}
                  </button>
                  <Show
                    when={
                      props.task.agentIds.length > 0 &&
                      store.agents[props.task.agentIds[0]]?.status === 'running'
                    }
                  >
                    <button
                      type="button"
                      onClick={() => {
                        const agentId = props.task.agentIds[0];
                        props.onDone();
                        sendPrompt(props.task.id, agentId, 'rebase on main branch').catch((err) => {
                          console.error('Failed to send rebase prompt:', err);
                        });
                      }}
                      title="Close dialog and ask the AI agent to rebase"
                      style={{
                        padding: '6px 14px',
                        background: theme.accent,
                        border: 'none',
                        'border-radius': '8px',
                        color: theme.accentText,
                        cursor: 'pointer',
                        'font-size': '13px',
                        'font-weight': '600',
                      }}
                    >
                      Rebase with AI
                    </button>
                  </Show>
                  <Show when={rebaseSuccess()}>
                    <span style={{ 'font-size': '13px', color: theme.success }}>
                      Rebase successful
                    </span>
                  </Show>
                  <Show when={rebaseError()}>
                    <span style={{ 'font-size': '13px', color: theme.error }}>{rebaseError()}</span>
                  </Show>
                </div>
              </Show>
            )}
          </Show>
          <p style={{ margin: '0 0 12px' }}>
            Merge <strong>{props.task.branchName}</strong> into main:
          </p>
          <Show when={!branchLog.loading && branchLog()}>
            {(log) => {
              const commits = () =>
                log()
                  .split('\n')
                  .filter((l: string) => l.trim())
                  .map((l: string) => {
                    const stripped = l.replace(/^- /, '');
                    const spaceIdx = stripped.indexOf(' ');
                    if (spaceIdx > 0) {
                      return {
                        hash: stripped.slice(0, spaceIdx),
                        msg: stripped.slice(spaceIdx + 1),
                      };
                    }
                    return { hash: '', msg: stripped };
                  });
              return (
                <div
                  style={{
                    'margin-bottom': '12px',
                    'max-height': '120px',
                    'overflow-y': 'auto',
                    'overflow-x': 'hidden',
                    'font-family': "'JetBrains Mono', monospace",
                    'font-size': '12px',
                    border: `1px solid ${theme.border}`,
                    'border-radius': '8px',
                    padding: '4px 0',
                  }}
                >
                  <For each={commits()}>
                    {(commit) => (
                      <div
                        title={`${commit.hash} ${commit.msg}`}
                        style={{
                          display: 'flex',
                          'align-items': 'center',
                          gap: '6px',
                          padding: '2px 8px',
                          'white-space': 'nowrap',
                          overflow: 'hidden',
                          'text-overflow': 'ellipsis',
                          color: theme.fg,
                        }}
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 10 10"
                          style={{ 'flex-shrink': '0' }}
                        >
                          <circle
                            cx="5"
                            cy="5"
                            r="3"
                            fill="none"
                            stroke={theme.accent}
                            stroke-width="1.5"
                          />
                        </svg>
                        <Show when={commit.hash}>
                          <span style={{ color: theme.fgMuted, 'flex-shrink': '0' }}>
                            {commit.hash}
                          </span>
                        </Show>
                        <span
                          style={{
                            overflow: 'hidden',
                            'text-overflow': 'ellipsis',
                          }}
                        >
                          {commit.msg}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              );
            }}
          </Show>
          <div
            style={{
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              overflow: 'hidden',
              'max-height': '240px',
              display: 'flex',
              'flex-direction': 'column',
            }}
          >
            <ChangedFilesList
              worktreePath={props.task.worktreePath}
              isActive={props.open}
              onFileClick={props.onDiffFileClick}
              baseBranch={props.task.baseBranch}
            />
          </div>
          <label
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              'margin-top': '12px',
              cursor: 'pointer',
              'font-size': '14px',
              color: theme.fg,
            }}
          >
            <input
              type="checkbox"
              checked={cleanupAfterMerge()}
              onChange={(e) => setCleanupAfterMerge(e.currentTarget.checked)}
              style={{ cursor: 'pointer' }}
            />
            Delete branch and worktree after merge
          </label>
          <label
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              'margin-top': '8px',
              cursor: 'pointer',
              'font-size': '14px',
              color: theme.fg,
            }}
          >
            <input
              type="checkbox"
              checked={squash()}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                setSquash(checked);
                if (checked && !squashMessage()) {
                  const log = branchLog() ?? '';
                  const msgOnly = log
                    .split('\n')
                    .map((l) => l.replace(/^- [a-f0-9]+ /, '- '))
                    .join('\n');
                  setSquashMessage(msgOnly);
                }
              }}
              style={{ cursor: 'pointer' }}
            />
            Squash commits
          </label>
          <Show when={squash()}>
            <textarea
              value={squashMessage()}
              onInput={(e) => setSquashMessage(e.currentTarget.value)}
              placeholder="Commit message..."
              rows={6}
              style={{
                'margin-top': '8px',
                width: '100%',
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': '8px',
                padding: '8px 10px',
                color: theme.fg,
                'font-size': '13px',
                'font-family': "'JetBrains Mono', monospace",
                resize: 'vertical',
                outline: 'none',
                'box-sizing': 'border-box',
              }}
            />
          </Show>
          <Show when={mergeError()}>
            <div
              style={{
                ...bannerStyle(theme.error),
                'margin-top': '12px',
                'font-size': '13px',
              }}
            >
              {mergeError()}
            </div>
          </Show>
        </div>
      }
      confirmDisabled={
        merging() || hasConflicts() || !hasCommittedChangesToMerge() || hasBranchMismatch()
      }
      confirmLoading={merging()}
      confirmLabel={merging() ? 'Merging...' : squash() ? 'Squash Merge' : 'Merge'}
      onConfirm={() => {
        const taskId = props.task.id;
        const onDone = props.onDone;
        setMergeError('');
        setMerging(true);
        void mergeTask(taskId, {
          squash: squash(),
          message: squash() ? squashMessage() || undefined : undefined,
          cleanup: cleanupAfterMerge(),
        })
          .then(() => {
            onDone();
          })
          .catch((err) => {
            setMergeError(String(err));
          })
          .finally(() => {
            setMerging(false);
          });
      }}
      onCancel={() => props.onDone()}
    />
  );
}
