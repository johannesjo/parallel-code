import { Show, createEffect } from 'solid-js';
import { theme } from '../lib/theme';
import { retrySetup, skipSetup } from '../store/store';
import type { Task } from '../store/types';

interface SetupBannerProps {
  task: Task;
}

export function SetupBanner(props: SetupBannerProps) {
  let logRef: HTMLPreElement | undefined;

  // Auto-scroll log to bottom when content changes
  createEffect(() => {
    void props.task.setupLog; // track
    if (logRef) logRef.scrollTop = logRef.scrollHeight;
  });

  return (
    <Show when={props.task.setupStatus === 'running' || props.task.setupStatus === 'failed'}>
      <div
        style={{
          background: theme.bgElevated,
          'border-bottom': `1px solid ${theme.border}`,
          padding: '8px 12px',
          'font-size': '12px',
          'flex-shrink': '0',
          display: 'flex',
          'flex-direction': 'column',
          gap: '6px',
          'max-height': '200px',
        }}
      >
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <Show when={props.task.setupStatus === 'running'}>
            <span
              style={{
                display: 'inline-block',
                width: '8px',
                height: '8px',
                'border-radius': '50%',
                background: theme.accent,
                animation: 'setup-pulse 1s ease-in-out infinite',
              }}
            />
            <span style={{ color: theme.fg }}>Running setup commands...</span>
          </Show>
          <Show when={props.task.setupStatus === 'failed'}>
            <span style={{ color: theme.error, 'font-weight': 'bold' }}>Setup failed</span>
            <Show when={props.task.setupError}>
              <span style={{ color: theme.fgMuted, 'margin-left': '4px' }}>
                {props.task.setupError}
              </span>
            </Show>
            <div style={{ 'margin-left': 'auto', display: 'flex', gap: '6px' }}>
              <button
                onClick={() => retrySetup(props.task.id)}
                style={{
                  background: theme.bgElevated,
                  border: `1px solid ${theme.border}`,
                  color: theme.fg,
                  padding: '2px 10px',
                  'border-radius': '4px',
                  cursor: 'pointer',
                  'font-size': '11px',
                }}
              >
                Retry
              </button>
              <button
                onClick={() => skipSetup(props.task.id)}
                style={{
                  background: 'transparent',
                  border: `1px solid ${theme.border}`,
                  color: theme.fgMuted,
                  padding: '2px 10px',
                  'border-radius': '4px',
                  cursor: 'pointer',
                  'font-size': '11px',
                }}
              >
                Skip
              </button>
            </div>
          </Show>
        </div>
        <Show when={props.task.setupLog}>
          <pre
            ref={logRef}
            style={{
              margin: '0',
              padding: '6px 8px',
              background: theme.taskPanelBg,
              'border-radius': '4px',
              'font-size': '11px',
              'line-height': '1.4',
              'overflow-y': 'auto',
              'overflow-x': 'hidden',
              'max-height': '120px',
              color: theme.fgMuted,
              'white-space': 'pre-wrap',
              'word-break': 'break-all',
            }}
          >
            {props.task.setupLog}
          </pre>
        </Show>
      </div>
      <style>{`
        @keyframes setup-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </Show>
  );
}
