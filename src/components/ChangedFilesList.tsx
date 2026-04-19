import { createSignal, createMemo, createEffect, onCleanup, batch, Index, Show } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { getStatusColor } from '../lib/status-colors';
import { buildFileTree, flattenVisibleTree } from '../lib/file-tree';
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
  /** Base branch for diff comparison (e.g. 'main', 'develop'). Undefined = auto-detect. */
  baseBranch?: string;
  /** When set to a commit hash, show files for that single commit. null/undefined = all changes. */
  selectedCommit?: string | null;
}

export function ChangedFilesList(props: ChangedFilesListProps) {
  const [files, setFiles] = createSignal<ChangedFile[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(-1);
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const rowRefs: HTMLDivElement[] = [];

  const tree = createMemo(() => buildFileTree(files()));
  const visibleRows = createMemo(() => flattenVisibleTree(tree(), collapsed()));

  function toggleDir(path: string) {
    const isCollapsing = !collapsed().has(path);
    const rows = visibleRows();
    const dirIdx = isCollapsing ? rows.findIndex((r) => r.node.path === path) : -1;

    batch(() => {
      // When collapsing, snap selection to the directory if selected item is a child
      if (dirIdx >= 0) {
        const dirDepth = rows[dirIdx].depth;
        const sel = selectedIndex();
        let subtreeEnd = rows.length;
        for (let j = dirIdx + 1; j < rows.length; j++) {
          if (rows[j].depth <= dirDepth) {
            subtreeEnd = j;
            break;
          }
        }
        if (sel > dirIdx && sel < subtreeEnd) {
          setSelectedIndex(dirIdx);
        }
      }

      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    });
  }

  // Scroll selected item into view reactively
  createEffect(() => {
    const idx = selectedIndex();
    if (idx >= 0) rowRefs[idx]?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  });

  // Trim stale refs and clamp selection when visible rows change
  createEffect(() => {
    const len = visibleRows().length;
    rowRefs.length = len;
    setSelectedIndex((i) => (i >= len ? len - 1 : i));
  });

  function handleKeyDown(e: KeyboardEvent) {
    const rows = visibleRows();
    if (rows.length === 0) return;
    const idx = selectedIndex();

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (idx >= 0 && idx < rows.length) {
        const row = rows[idx];
        if (row.isDir && collapsed().has(row.node.path)) {
          toggleDir(row.node.path);
        } else if (row.isDir && idx + 1 < rows.length) {
          // Already expanded — move to first child
          setSelectedIndex(idx + 1);
        }
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (idx >= 0 && idx < rows.length) {
        const row = rows[idx];
        if (row.isDir && !collapsed().has(row.node.path)) {
          // Collapse this directory
          toggleDir(row.node.path);
        } else if (row.depth > 0) {
          // Move to parent directory
          for (let j = idx - 1; j >= 0; j--) {
            if (rows[j].isDir && rows[j].depth === row.depth - 1) {
              setSelectedIndex(j);
              break;
            }
          }
        }
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (idx >= 0 && idx < rows.length) {
        const row = rows[idx];
        if (row.isDir) {
          toggleDir(row.node.path);
        } else if (row.node.file) {
          props.onFileClick?.(row.node.file);
        }
      }
    }
  }

  // Poll every 5s, matching the git status polling interval.
  // Falls back to branch-based diff when worktree path doesn't exist.
  // When selectedCommit is set, fetches files for that single commit (no polling).
  createEffect(() => {
    const path = props.worktreePath;
    const projectRoot = props.projectRoot;
    const branchName = props.branchName;
    const baseBranch = props.baseBranch;
    const commitHash = props.selectedCommit;
    // In single-commit mode the user explicitly navigated — always fetch.
    // In all-changes mode skip when inactive to avoid background polling.
    if (!commitHash && !props.isActive) return;
    let cancelled = false;
    let inFlight = false;
    let usingBranchFallback = false;

    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        // Single-commit mode: fetch files for that commit only
        if (commitHash && path) {
          try {
            const result = await invoke<ChangedFile[]>(IPC.GetCommitChangedFiles, {
              worktreePath: path,
              commitHash,
            });
            if (!cancelled) setFiles(result);
          } catch {
            if (!cancelled) setFiles([]);
          }
          return;
        }

        // Try worktree-based fetch first
        if (path && !usingBranchFallback) {
          try {
            const result = await invoke<ChangedFile[]>(IPC.GetChangedFiles, {
              worktreePath: path,
              baseBranch,
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
              baseBranch,
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
    // No polling needed for single-commit view (committed data is immutable)
    const timer = commitHash
      ? undefined
      : setInterval(() => {
          if (!usingBranchFallback) void refresh();
        }, 5000);
    onCleanup(() => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
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
        'font-size': sf(12),
        outline: 'none',
      }}
    >
      <div style={{ flex: '1', overflow: 'auto', padding: '4px 0' }}>
        <Index each={visibleRows()}>
          {(row, i) => (
            <div
              ref={(el) => (rowRefs[i] = el)}
              class="file-row"
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '6px',
                padding: '2px 8px',
                'padding-left': `${8 + row().depth * 8}px`,
                'white-space': 'nowrap',
                cursor: 'pointer',
                'border-radius': '3px',
                opacity:
                  !props.selectedCommit && (row().isDir || row().node.file?.committed)
                    ? '0.45'
                    : '1',
                background: selectedIndex() === i ? theme.bgHover : 'transparent',
              }}
              onClick={() => {
                setSelectedIndex(i);
                const r = row();
                if (r.isDir) {
                  toggleDir(r.node.path);
                } else if (r.node.file) {
                  props.onFileClick?.(r.node.file);
                }
              }}
            >
              {row().isDir ? (
                <>
                  <span
                    style={{
                      color: theme.fg,
                      width: '10px',
                      'text-align': 'center',
                      'flex-shrink': '0',
                      'font-size': sf(10),
                    }}
                  >
                    {collapsed().has(row().node.path) ? '\u25B8' : '\u25BE'}
                  </span>
                  <span
                    style={{
                      flex: '1',
                      overflow: 'hidden',
                      'text-overflow': 'ellipsis',
                      color: theme.fg,
                    }}
                    title={row().node.path}
                  >
                    {row().node.name}/
                  </span>
                  <Show when={collapsed().has(row().node.path)}>
                    <span
                      style={{
                        color: theme.fg,
                        'font-size': sf(11),
                        'flex-shrink': '0',
                      }}
                    >
                      {row().node.fileCount}
                    </span>
                    <Show when={row().node.linesAdded > 0 || row().node.linesRemoved > 0}>
                      <span style={{ color: theme.success, 'flex-shrink': '0' }}>
                        +{row().node.linesAdded}
                      </span>
                      <span style={{ color: theme.error, 'flex-shrink': '0' }}>
                        -{row().node.linesRemoved}
                      </span>
                    </Show>
                  </Show>
                </>
              ) : (
                <>
                  <span
                    style={{
                      color: getStatusColor(row().node.file?.status ?? ''),
                      'font-weight': '600',
                      width: '12px',
                      'text-align': 'center',
                      'flex-shrink': '0',
                    }}
                  >
                    {row().node.file?.status}
                  </span>
                  <span
                    style={{
                      flex: '1',
                      overflow: 'hidden',
                      'text-overflow': 'ellipsis',
                      color: theme.fg,
                    }}
                    title={row().node.path}
                  >
                    {row().node.name}
                  </span>
                  <Show
                    when={
                      (row().node.file?.lines_added ?? 0) > 0 ||
                      (row().node.file?.lines_removed ?? 0) > 0
                    }
                  >
                    <span style={{ color: theme.success, 'flex-shrink': '0' }}>
                      +{row().node.file?.lines_added}
                    </span>
                    <span style={{ color: theme.error, 'flex-shrink': '0' }}>
                      -{row().node.file?.lines_removed}
                    </span>
                  </Show>
                </>
              )}
            </div>
          )}
        </Index>
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
          <Show when={uncommittedCount() > 0}>
            {' '}
            <span style={{ color: theme.warning }}>({uncommittedCount()} uncommitted)</span>
          </Show>
        </div>
      </Show>
    </div>
  );
}
