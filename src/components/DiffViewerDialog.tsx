import { Show, createSignal, createEffect } from 'solid-js';
import { Dialog } from './Dialog';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { DiffView, DiffModeEnum } from '@git-diff-view/solid';
import '@git-diff-view/solid/styles/diff-view.css';
import { theme } from '../lib/theme';
import { isBinaryDiff } from '../lib/diff-parser';
import { getStatusColor } from '../lib/status-colors';
import { openFileInEditor } from '../lib/shell';
import type { ChangedFile } from '../ipc/types';

interface DiffViewerDialogProps {
  file: ChangedFile | null;
  worktreePath: string;
  onClose: () => void;
  /** Project root for branch-based fallback when worktree doesn't exist */
  projectRoot?: string;
  /** Branch name for branch-based fallback when worktree doesn't exist */
  branchName?: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  '?': 'Untracked',
};

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  rs: 'rust',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  dockerfile: 'dockerfile',
  lua: 'lua',
  cpp: 'cpp',
  c: 'c',
  h: 'c',
  hpp: 'cpp',
};

function detectLang(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const basename = filePath.split('/').pop()?.toLowerCase() ?? '';
  if (basename === 'dockerfile') return 'dockerfile';
  if (basename === 'makefile') return 'makefile';
  return EXT_TO_LANG[ext] ?? 'plaintext';
}

export function DiffViewerDialog(props: DiffViewerDialogProps) {
  const [rawDiff, setRawDiff] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [binary, setBinary] = createSignal(false);
  const [viewMode, setViewMode] = createSignal(DiffModeEnum.Split);

  createEffect(() => {
    const file = props.file;
    if (!file) return;

    const worktreePath = props.worktreePath;
    const projectRoot = props.projectRoot;
    const branchName = props.branchName;

    setLoading(true);
    setError('');
    setBinary(false);
    setRawDiff('');

    const worktreePromise = worktreePath
      ? invoke<string>(IPC.GetFileDiff, { worktreePath, filePath: file.path })
      : Promise.reject(new Error('no worktree'));

    worktreePromise
      .catch(() => {
        // Worktree may not exist — try branch-based fallback
        if (projectRoot && branchName) {
          return invoke<string>(IPC.GetFileDiffFromBranch, {
            projectRoot,
            branchName,
            filePath: file.path,
          });
        }
        return '';
      })
      .then((raw) => {
        if (isBinaryDiff(raw)) {
          setBinary(true);
        } else {
          setRawDiff(raw);
        }
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  });

  return (
    <Dialog
      open={props.file !== null}
      onClose={props.onClose}
      width="90vw"
      panelStyle={{
        height: '85vh',
        'max-width': '1400px',
        overflow: 'hidden',
        padding: '0',
        gap: '0',
      }}
    >
      <Show when={props.file}>
        {(file) => (
          <>
            {/* Header */}
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '10px',
                padding: '16px 20px',
                'border-bottom': `1px solid ${theme.border}`,
                'flex-shrink': '0',
              }}
            >
              <span
                style={{
                  'font-size': '11px',
                  'font-weight': '600',
                  padding: '2px 8px',
                  'border-radius': '4px',
                  color: getStatusColor(file().status),
                  background: 'rgba(255,255,255,0.06)',
                }}
              >
                {STATUS_LABELS[file().status] ?? file().status}
              </span>
              <span
                style={{
                  flex: '1',
                  'font-size': '13px',
                  'font-family': "'JetBrains Mono', monospace",
                  color: theme.fg,
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  'white-space': 'nowrap',
                }}
              >
                {file().path}
              </span>

              {/* Split / Unified toggle */}
              <div
                style={{
                  display: 'flex',
                  gap: '2px',
                  background: 'rgba(255,255,255,0.04)',
                  'border-radius': '6px',
                  padding: '2px',
                }}
              >
                <button
                  onClick={() => setViewMode(DiffModeEnum.Split)}
                  style={{
                    background:
                      viewMode() === DiffModeEnum.Split ? 'rgba(255,255,255,0.10)' : 'transparent',
                    border: 'none',
                    color: viewMode() === DiffModeEnum.Split ? theme.fg : theme.fgMuted,
                    'font-size': '11px',
                    padding: '3px 10px',
                    'border-radius': '4px',
                    cursor: 'pointer',
                    'font-family': 'inherit',
                  }}
                >
                  Split
                </button>
                <button
                  onClick={() => setViewMode(DiffModeEnum.Unified)}
                  style={{
                    background:
                      viewMode() === DiffModeEnum.Unified
                        ? 'rgba(255,255,255,0.10)'
                        : 'transparent',
                    border: 'none',
                    color: viewMode() === DiffModeEnum.Unified ? theme.fg : theme.fgMuted,
                    'font-size': '11px',
                    padding: '3px 10px',
                    'border-radius': '4px',
                    cursor: 'pointer',
                    'font-family': 'inherit',
                  }}
                >
                  Unified
                </button>
              </div>

              <button
                onClick={() => openFileInEditor(props.worktreePath, file().path)}
                disabled={!props.worktreePath}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: theme.fgMuted,
                  cursor: props.worktreePath ? 'pointer' : 'default',
                  opacity: props.worktreePath ? '1' : '0.3',
                  padding: '4px',
                  display: 'flex',
                  'align-items': 'center',
                  'border-radius': '4px',
                }}
                title="Open in editor"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.5 2a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3a.75.75 0 0 1 1.5 0v3A3 3 0 0 1 12.5 16h-9A3 3 0 0 1 0 12.5v-9A3 3 0 0 1 3.5 0h3a.75.75 0 0 1 0 1.5h-3ZM10 .75a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V2.56L8.53 8.53a.75.75 0 0 1-1.06-1.06L13.44 1.5H10.75A.75.75 0 0 1 10 .75Z" />
                </svg>
              </button>

              <button
                onClick={() => props.onClose()}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: theme.fgMuted,
                  cursor: 'pointer',
                  padding: '4px',
                  display: 'flex',
                  'align-items': 'center',
                  'border-radius': '4px',
                }}
                title="Close"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div
              style={{
                flex: '1',
                overflow: 'auto',
              }}
            >
              <Show when={loading()}>
                <div style={{ padding: '40px', 'text-align': 'center', color: theme.fgMuted }}>
                  Loading diff...
                </div>
              </Show>

              <Show when={error()}>
                <div style={{ padding: '40px', 'text-align': 'center', color: theme.error }}>
                  {error()}
                </div>
              </Show>

              <Show when={binary()}>
                <div style={{ padding: '40px', 'text-align': 'center', color: theme.fgMuted }}>
                  Binary file — cannot display diff
                </div>
              </Show>

              <Show when={!loading() && !error() && !binary() && !rawDiff()}>
                <div style={{ padding: '40px', 'text-align': 'center', color: theme.fgMuted }}>
                  No changes
                </div>
              </Show>

              <Show when={!loading() && !error() && !binary() && rawDiff()}>
                <DiffView
                  data={{
                    oldFile: { fileName: file().path, fileLang: detectLang(file().path) },
                    newFile: { fileName: file().path, fileLang: detectLang(file().path) },
                    hunks: [rawDiff()],
                  }}
                  diffViewMode={viewMode()}
                  diffViewTheme="dark"
                  diffViewHighlight
                  diffViewWrap={false}
                  diffViewFontSize={12}
                />
              </Show>
            </div>
          </>
        )}
      </Show>
    </Dialog>
  );
}
