import { createSignal, createMemo, createEffect, onCleanup, For, Show } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { getStatusColor } from '../lib/status-colors';
import type { ChangedFile } from '../ipc/types';

interface ChangedFilesListProps {
  worktreePath: string;
  isActive?: boolean;
  onFileClick?: (file: ChangedFile) => void;
  ref?: (el: HTMLDivElement) => void;
  /** Project root for branch-based fallback when worktree doesn't exist */
  projectRoot?: string;
  /** Branch name for branch-based fallback when worktree doesn't exist */
  branchName?: string | null;
}

export function ChangedFilesList(props: ChangedFilesListProps) {
  const [files, setFiles] = createSignal<ChangedFile[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(-1);

  function handleKeyDown(e: KeyboardEvent) {
    const list = files();
    if (list.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(list.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const idx = selectedIndex();
      if (idx >= 0 && idx < list.length) {
        props.onFileClick?.(list[idx]);
      }
    }
  }

  // Poll every 5s, matching the git status polling interval.
  // Falls back to branch-based diff when worktree path doesn't exist.
  createEffect(() => {
    const path = props.worktreePath;
    const projectRoot = props.projectRoot;
    const branchName = props.branchName;
    if (!props.isActive) return;
    let cancelled = false;
    let inFlight = false;
    let usingBranchFallback = false;

    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        // Try worktree-based fetch first
        if (path && !usingBranchFallback) {
          try {
            const result = await invoke<ChangedFile[]>(IPC.GetChangedFiles, {
              worktreePath: path,
            });
            if (!cancelled) setFiles(result);
            return;
          } catch {
            // Worktree may not exist — try branch fallback below
          }
        }

        // Branch-based fallback: static data, no need to re-poll
        if (!usingBranchFallback && projectRoot && branchName) {
          usingBranchFallback = true;
          try {
            const result = await invoke<ChangedFile[]>(IPC.GetChangedFilesFromBranch, {
              projectRoot,
              branchName,
            });
            if (!cancelled) setFiles(result);
          } catch {
            // Branch may no longer exist
          }
        }
      } finally {
        inFlight = false;
      }
    }

    void refresh();
    const timer = setInterval(() => {
      if (!usingBranchFallback) void refresh();
    }, 5000);
    onCleanup(() => {
      cancelled = true;
      clearInterval(timer);
    });
  });

  const totalAdded = createMemo(() => files().reduce((s, f) => s + f.lines_added, 0));
  const totalRemoved = createMemo(() => files().reduce((s, f) => s + f.lines_removed, 0));
  const uncommittedCount = createMemo(() => files().filter((f) => !f.committed).length);

  return (
    <div
      ref={props.ref}
      class="focusable-panel"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        overflow: 'hidden',
        'font-family': "'JetBrains Mono', monospace",
        'font-size': sf(11),
        outline: 'none',
      }}
    >
      <div style={{ flex: '1', overflow: 'auto', padding: '4px 0' }}>
        <For each={files()}>
          {(file, i) => (
            <div
              class="file-row"
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '6px',
                padding: '2px 8px',
                'white-space': 'nowrap',
                cursor: props.onFileClick ? 'pointer' : 'default',
                'border-radius': '3px',
                opacity: file.committed ? '0.45' : '1',
                background: selectedIndex() === i() ? theme.bgHover : 'transparent',
              }}
              onClick={() => {
                setSelectedIndex(i());
                props.onFileClick?.(file);
              }}
            >
              <span
                style={{
                  color: getStatusColor(file.status),
                  'font-weight': '600',
                  width: '12px',
                  'text-align': 'center',
                  'flex-shrink': '0',
                }}
              >
                {file.status}
              </span>
              <span
                style={{
                  flex: '1',
                  color: theme.fg,
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                }}
              >
                {file.path}
              </span>
              <Show when={file.lines_added > 0 || file.lines_removed > 0}>
                <span style={{ color: theme.success, 'flex-shrink': '0' }}>
                  +{file.lines_added}
                </span>
                <span style={{ color: theme.error, 'flex-shrink': '0' }}>
                  -{file.lines_removed}
                </span>
              </Show>
            </div>
          )}
        </For>
      </div>
      <Show when={files().length > 0}>
        <div
          style={{
            padding: '4px 8px',
            'border-top': `1px solid ${theme.border}`,
            color: theme.fgMuted,
            'flex-shrink': '0',
          }}
        >
          {files().length} files, <span style={{ color: theme.success }}>+{totalAdded()}</span>{' '}
          <span style={{ color: theme.error }}>-{totalRemoved()}</span>
          <Show when={uncommittedCount() > 0 && uncommittedCount() < files().length}>
            {' '}
            <span style={{ color: theme.warning }}>({uncommittedCount()} uncommitted)</span>
          </Show>
        </div>
      </Show>
    </div>
  );
}
