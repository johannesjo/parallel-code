import { For, Show, createEffect, createResource, createSignal } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { refreshTaskStatus } from '../store/store';
import { ConfirmDialog } from './ConfirmDialog';
import { theme, bannerStyle } from '../lib/theme';
import type { Task } from '../store/types';
import { loadCommitFiles } from '../lib/commit-status';
import { errMessage } from '../lib/log';

type BusyKind = 'staging' | 'unstaging' | 'committing';

interface CommitDialogProps {
  open: boolean;
  task: Task;
  onDone: () => void;
}

export function CommitDialog(props: CommitDialogProps) {
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal<BusyKind | null>(null);

  const [snapshot, { refetch, mutate }] = createResource(
    () => (props.open ? props.task.worktreePath : null),
    loadCommitFiles,
  );
  const files = () => snapshot() ?? [];
  const stagedCount = () => files().filter((f) => f.staged).length;
  const unstagedCount = () => files().length - stagedCount();

  createEffect(() => {
    if (props.open) {
      setMessage('');
      setError('');
      setBusy(null);
      mutate(undefined);
      void refetch();
    }
  });

  async function run(kind: BusyKind, action: (worktreePath: string) => Promise<unknown>) {
    const { id: taskId, worktreePath } = props.task;
    setError('');
    setBusy(kind);
    try {
      await action(worktreePath);
      return true;
    } catch (err: unknown) {
      setError(errMessage(err));
      return false;
    } finally {
      setBusy(null);
      refreshTaskStatus(taskId);
    }
  }

  async function stageAll() {
    await run('staging', (worktreePath) => invoke(IPC.StageAll, { worktreePath }));
    void refetch();
  }

  async function unstageAll() {
    await run('unstaging', (worktreePath) => invoke(IPC.UnstageAll, { worktreePath }));
    void refetch();
  }

  async function commit() {
    const onDone = props.onDone;
    const commitMessage = message().trim();
    const ok = await run('committing', (worktreePath) =>
      invoke(IPC.CommitStaged, { worktreePath, message: commitMessage }),
    );
    if (ok) onDone();
    else void refetch();
  }

  return (
    <ConfirmDialog
      open={props.open}
      title="Commit changes"
      width="520px"
      autoFocusCancel={false}
      message={
        <div>
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              gap: '8px',
              'margin-bottom': '8px',
            }}
          >
            <span style={{ 'font-size': '13px' }}>
              <Show when={!snapshot.loading} fallback="Loading changes...">
                {stagedCount()} staged, {unstagedCount()} not staged
              </Show>
            </span>
            <div style={{ display: 'flex', gap: '6px' }}>
              <StagingButton
                label={busy() === 'unstaging' ? 'Unstaging...' : 'Unstage all'}
                title="git reset"
                disabled={busy() !== null || stagedCount() === 0}
                onClick={() => void unstageAll()}
              />
              <StagingButton
                label={busy() === 'staging' ? 'Staging...' : 'Stage all'}
                title="git add -A"
                disabled={busy() !== null || unstagedCount() === 0}
                onClick={() => void stageAll()}
              />
            </div>
          </div>
          <Show
            when={files().length > 0}
            fallback={
              <Show when={!snapshot.loading}>
                <div style={{ 'font-size': '13px', 'margin-bottom': '8px' }}>
                  No uncommitted changes.
                </div>
              </Show>
            }
          >
            <ul
              style={{
                margin: '0 0 8px',
                padding: '6px 10px',
                'list-style': 'none',
                'max-height': '180px',
                'overflow-y': 'auto',
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': 'var(--radius-md)',
                'font-family': "'JetBrains Mono', monospace",
                'font-size': '12px',
              }}
            >
              <For each={files()}>
                {(file) => {
                  const staged = () => file.staged;
                  return (
                    <li style={{ display: 'flex', gap: '8px', 'white-space': 'nowrap' }}>
                      <span
                        style={{ color: staged() ? theme.success : theme.fgMuted, width: '14px' }}
                        title={staged() ? 'Staged' : 'Not staged'}
                      >
                        {staged() ? '✓' : '·'}
                      </span>
                      <span style={{ width: '12px' }}>{file.status}</span>
                      <span
                        style={{
                          color: staged() ? theme.fg : theme.fgMuted,
                          overflow: 'hidden',
                          'text-overflow': 'ellipsis',
                        }}
                        title={file.path}
                      >
                        {file.path}
                      </span>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
          <textarea
            value={message()}
            onInput={(e) => setMessage(e.currentTarget.value)}
            placeholder="Commit message..."
            aria-label="Commit message"
            rows={4}
            style={{
              width: '100%',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-md)',
              padding: '8px 10px',
              color: theme.fg,
              'font-size': '13px',
              'font-family': "'JetBrains Mono', monospace",
              resize: 'vertical',
              outline: 'none',
              'box-sizing': 'border-box',
            }}
          />
          <Show when={error()}>
            <div style={{ ...bannerStyle(theme.error), 'margin-top': '12px', 'font-size': '13px' }}>
              {error()}
            </div>
          </Show>
        </div>
      }
      confirmDisabled={busy() !== null || stagedCount() === 0 || !message().trim()}
      confirmLoading={busy() === 'committing'}
      confirmLabel={busy() === 'committing' ? 'Committing...' : 'Commit'}
      onConfirm={() => void commit()}
      onCancel={() => props.onDone()}
    />
  );
}

function StagingButton(props: {
  label: string;
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={() => props.onClick()}
      title={props.title}
      style={{
        padding: '4px 12px',
        background: theme.bgInput,
        border: `1px solid ${theme.border}`,
        'border-radius': 'var(--radius-sm)',
        color: theme.fg,
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        opacity: props.disabled ? '0.5' : '1',
        'font-size': '13px',
      }}
    >
      {props.label}
    </button>
  );
}
