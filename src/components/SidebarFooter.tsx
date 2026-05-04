import { createMemo, createEffect, onCleanup, Show } from 'solid-js';
import {
  store,
  getCompletedTasksTodayCount,
  getMergedLineTotals,
  toggleHelpDialog,
  toggleArena,
  hasAnyCoordinatorTask,
  startMCPStatusPolling,
  stopMCPStatusPolling,
} from '../store/store';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { alt, mod } from '../lib/platform';

export function SidebarFooter() {
  const completedTasksToday = createMemo(() => getCompletedTasksTodayCount());
  const mergedLines = createMemo(() => getMergedLineTotals());
  const hasCoordinator = createMemo(() => hasAnyCoordinatorTask());

  createEffect(() => {
    if (hasCoordinator()) {
      startMCPStatusPolling();
    } else {
      stopMCPStatusPolling();
    }
  });

  onCleanup(() => stopMCPStatusPolling());

  const mcpOk = () => store.mcpStatus.remoteRunning;

  return (
    <>
      <Show when={hasCoordinator()}>
        <div
          style={{
            'border-top': `1px solid ${theme.border}`,
            'padding-top': '12px',
            display: 'flex',
            'align-items': 'center',
            gap: '8px',
            'flex-shrink': '0',
          }}
        >
          <div
            style={{
              width: '8px',
              height: '8px',
              'border-radius': '50%',
              background: mcpOk() ? theme.success : theme.error,
              'flex-shrink': '0',
            }}
          />
          <span
            style={{
              'font-size': sf(11),
              color: theme.fgMuted,
            }}
          >
            MCP {mcpOk() ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </Show>

      <div
        style={{
          'border-top': `1px solid ${theme.border}`,
          'padding-top': '12px',
          display: 'flex',
          'flex-direction': 'column',
          gap: '6px',
          'flex-shrink': '0',
        }}
      >
        <Show when={store.showSidebarProgress}>
          <span
            style={{
              'font-size': sf(11),
              color: theme.fgSubtle,
              'text-transform': 'uppercase',
              'letter-spacing': '0.05em',
            }}
          >
            Progress
          </span>
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '8px 10px',
              'font-size': sf(12),
              color: theme.fgMuted,
            }}
          >
            <span>Completed today</span>
            <span
              style={{
                color: theme.fg,
                'font-weight': '600',
                'font-variant-numeric': 'tabular-nums',
              }}
            >
              {completedTasksToday()}
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '8px 10px',
              'font-size': sf(12),
              color: theme.fgMuted,
            }}
          >
            <span>Merged to main/master</span>
            <span
              style={{
                color: theme.fg,
                'font-weight': '600',
                'font-variant-numeric': 'tabular-nums',
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
              }}
            >
              <span style={{ color: theme.success }}>+{mergedLines().added.toLocaleString()}</span>
              <span style={{ color: theme.error }}>-{mergedLines().removed.toLocaleString()}</span>
            </span>
          </div>
        </Show>
        <button
          onClick={() => toggleArena(true)}
          style={{
            width: '100%',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            gap: '6px',
            background: 'transparent',
            border: `1px solid ${theme.border}`,
            'border-radius': '8px',
            padding: '8px 14px',
            'font-size': sf(13),
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-family': 'inherit',
            'font-weight': '500',
            'margin-top': store.showSidebarProgress ? '6px' : '0',
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M3 3L13 13M9 12L12 9" />
            <path d="M13 3L3 13M4 9L7 12" />
          </svg>
          Arena
        </button>
      </div>

      {/* Tips */}
      <Show when={store.showSidebarTips}>
        <div
          onClick={() => toggleHelpDialog(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggleHelpDialog(true);
            }
          }}
          tabIndex={0}
          role="button"
          style={{
            'border-top': `1px solid ${theme.border}`,
            'padding-top': '12px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '6px',
            'flex-shrink': '0',
            cursor: 'pointer',
          }}
        >
          <span
            style={{
              'font-size': sf(11),
              color: theme.fgSubtle,
              'text-transform': 'uppercase',
              'letter-spacing': '0.05em',
            }}
          >
            Tips
          </span>
          <span
            style={{
              'font-size': sf(12),
              color: theme.fgMuted,
              'line-height': '1.4',
            }}
          >
            <kbd
              style={{
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': '3px',
                padding: '1px 4px',
                'font-size': sf(11),
                'font-family': "'JetBrains Mono', monospace",
              }}
            >
              {alt} + Arrows
            </kbd>{' '}
            to navigate panels
          </span>
          <span
            style={{
              'font-size': sf(12),
              color: theme.fgMuted,
              'line-height': '1.4',
            }}
          >
            <kbd
              style={{
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': '3px',
                padding: '1px 4px',
                'font-size': sf(11),
                'font-family': "'JetBrains Mono', monospace",
              }}
            >
              {mod} + /
            </kbd>{' '}
            for all shortcuts
          </span>
        </div>
      </Show>
    </>
  );
}
