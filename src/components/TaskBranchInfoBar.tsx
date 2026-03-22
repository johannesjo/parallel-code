import { Show } from 'solid-js';
import { store, getProject, showNotification } from '../store/store';
import { revealItemInDir, openInEditor } from '../lib/shell';
import { InfoBar } from './InfoBar';
import { theme } from '../lib/theme';
import { isMac } from '../lib/platform';
import type { Task } from '../store/types';

interface TaskBranchInfoBarProps {
  task: Task;
  onEditProject: (projectId: string) => void;
}

export function TaskBranchInfoBar(props: TaskBranchInfoBarProps) {
  const editorTitle = () =>
    store.editorCommand
      ? `Click to open in ${store.editorCommand} · ${isMac ? 'Cmd' : 'Ctrl'}+Click to reveal in file manager`
      : 'Click to reveal in file manager';

  const handleOpenInEditor = (e: MouseEvent) => {
    if (store.editorCommand && !e.ctrlKey && !e.metaKey) {
      openInEditor(store.editorCommand, props.task.worktreePath).catch((err) =>
        showNotification(
          `Editor failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        ),
      );
    } else {
      revealItemInDir(props.task.worktreePath).catch((err) =>
        showNotification(
          `Could not open folder: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  };

  return (
    <InfoBar>
      {(() => {
        const project = getProject(props.task.projectId);
        return (
          <Show when={project}>
            {(p) => (
              <button
                type="button"
                onClick={() => props.onEditProject(p().id)}
                title="Project settings"
                style={{
                  display: 'inline-flex',
                  'align-items': 'center',
                  gap: '4px',
                  background: 'transparent',
                  border: 'none',
                  padding: '0 4px',
                  margin: '0 8px 0 0',
                  'align-self': 'stretch',
                  color: 'inherit',
                  cursor: 'pointer',
                  'font-family': 'inherit',
                  'font-size': 'inherit',
                }}
              >
                <div
                  style={{
                    width: '7px',
                    height: '7px',
                    'border-radius': '50%',
                    background: p().color,
                    'flex-shrink': '0',
                  }}
                />
                {p().name}
              </button>
            )}
          </Show>
        );
      })()}
      <Show when={props.task.githubUrl}>
        {(url) => (
          <button
            type="button"
            onClick={() => window.open(url(), '_blank')}
            title={url()}
            style={{
              display: 'inline-flex',
              'align-items': 'center',
              gap: '4px',
              'margin-right': '8px',
              background: 'transparent',
              border: 'none',
              padding: '0 4px',
              'align-self': 'stretch',
              color: theme.accent,
              cursor: 'pointer',
              'font-family': 'inherit',
              'font-size': 'inherit',
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="currentColor"
              style={{ 'flex-shrink': '0' }}
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            {url().replace(/^https?:\/\/(www\.)?github\.com\//, '')}
          </button>
        )}
      </Show>
      <button
        type="button"
        title={editorTitle()}
        onClick={handleOpenInEditor}
        style={{
          display: 'inline-flex',
          'align-items': 'center',
          gap: '4px',
          'margin-right': '12px',
          'align-self': 'stretch',
          background: 'transparent',
          border: 'none',
          padding: '0 4px',
          color: 'inherit',
          cursor: 'pointer',
          'font-family': 'inherit',
          'font-size': 'inherit',
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="currentColor"
          style={{ 'flex-shrink': '0' }}
        >
          <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
        </svg>
        <Show when={!props.task.directMode}>{props.task.branchName}</Show>
        <Show when={props.task.directMode}>
          <span
            style={{
              'font-size': '10px',
              'font-weight': '600',
              padding: '1px 6px',
              'border-radius': '4px',
              background: `color-mix(in srgb, ${theme.warning} 15%, transparent)`,
              color: theme.warning,
              border: `1px solid color-mix(in srgb, ${theme.warning} 25%, transparent)`,
            }}
          >
            {props.task.branchName}
          </span>
        </Show>
      </button>
      <button
        type="button"
        title={editorTitle()}
        onClick={handleOpenInEditor}
        style={{
          display: 'inline-flex',
          'align-items': 'center',
          gap: '4px',
          'align-self': 'stretch',
          background: 'transparent',
          border: 'none',
          padding: '0 4px',
          color: 'inherit',
          cursor: 'pointer',
          opacity: 0.6,
          'font-family': 'inherit',
          'font-size': 'inherit',
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="currentColor"
          style={{ 'flex-shrink': '0' }}
        >
          <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
        </svg>
        {props.task.worktreePath}
      </button>
    </InfoBar>
  );
}
