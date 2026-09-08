import { createMemo, createEffect, onCleanup, Show, type JSX } from 'solid-js';
import {
  store,
  getMergedTasksTodayCount,
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

const footerButtonStyle = (highlighted: boolean): JSX.CSSProperties => ({
  flex: '1',
  'min-width': '0',
  display: 'flex',
  'align-items': 'center',
  'justify-content': 'center',
  gap: '6px',
  background: 'transparent',
  border: `1px solid ${highlighted ? theme.success : theme.border}`,
  'border-radius': 'var(--radius-md)',
  padding: '6px 10px',
  'font-size': sf(12),
  'font-weight': '500',
  'font-family': 'inherit',
  color: highlighted ? theme.success : theme.fgMuted,
  cursor: 'pointer',
  'white-space': 'nowrap',
});

const kbdStyle: JSX.CSSProperties = {
  background: theme.bgInput,
  border: `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-xs)',
  padding: '1px 4px',
  'font-size': sf(11),
  'font-family': 'var(--font-mono)',
};

/** Sidebar bottom block: the two launchers (phone, arena) on one row, then a
 *  single progress line and a single tips line. Kept to a few rows so the
 *  task list above gets the space. */
export function SidebarFooter(props: { onConnectPhone: () => void }) {
  const mergedTasksToday = createMemo(() => getMergedTasksTodayCount());
  const mergedLines = createMemo(() => getMergedLineTotals());
  const hasCoordinator = createMemo(() => hasAnyCoordinatorTask());
  const phoneConnected = () =>
    store.remoteAccess.enabled && store.remoteAccess.connectedClients > 0;

  createEffect(() => {
    if (hasCoordinator()) {
      startMCPStatusPolling();
    } else {
      stopMCPStatusPolling();
    }
  });

  onCleanup(() => stopMCPStatusPolling());

  const mcpOk = () => store.mcpStatus.running;

  return (
    <div
      style={{
        'border-top': `1px solid ${theme.border}`,
        'padding-top': '12px',
        display: 'flex',
        'flex-direction': 'column',
        gap: '8px',
        'flex-shrink': '0',
      }}
    >
      <Show when={hasCoordinator()}>
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <div
            style={{
              width: '8px',
              height: '8px',
              'border-radius': '50%',
              background: mcpOk() ? theme.success : theme.error,
              'flex-shrink': '0',
            }}
          />
          <span style={{ 'font-size': sf(11), color: theme.fgMuted }}>
            MCP {mcpOk() ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </Show>

      <div style={{ display: 'flex', gap: '6px' }}>
        <button
          onClick={() => props.onConnectPhone()}
          title={
            phoneConnected()
              ? 'Phone connected: manage remote access'
              : 'Connect a phone for remote access'
          }
          style={footerButtonStyle(phoneConnected())}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <line x1="12" y1="18" x2="12.01" y2="18" />
          </svg>
          {phoneConnected() ? 'Phone connected' : 'Phone'}
        </button>
        <button
          onClick={() => toggleArena(true)}
          title="Arena: run two agents on the same prompt and compare"
          style={footerButtonStyle(false)}
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
            aria-hidden="true"
          >
            <path d="M3 3L13 13M9 12L12 9" />
            <path d="M13 3L3 13M4 9L7 12" />
          </svg>
          Arena
        </button>
      </div>

      <Show when={store.showSidebarProgress}>
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            'font-size': sf(11),
            color: theme.fgSubtle,
            'font-variant-numeric': 'tabular-nums',
            'white-space': 'nowrap',
          }}
          title="Tasks merged today, and lines added / removed across all merged tasks"
        >
          <span>Merged today</span>
          <span style={{ color: theme.fg, 'font-weight': '600' }}>{mergedTasksToday()}</span>
          <span aria-hidden="true">·</span>
          <span style={{ color: theme.success }}>+{mergedLines().added.toLocaleString()}</span>
          <span style={{ color: theme.error }}>-{mergedLines().removed.toLocaleString()}</span>
        </div>
      </Show>

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
          title="Open the keyboard shortcuts overview"
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            'font-size': sf(11),
            color: theme.fgSubtle,
            cursor: 'pointer',
            'white-space': 'nowrap',
          }}
        >
          <kbd style={kbdStyle}>{alt} + Arrows</kbd>
          <span>panels</span>
          <span aria-hidden="true">·</span>
          <kbd style={kbdStyle}>{mod} + /</kbd>
          <span>shortcuts</span>
        </div>
      </Show>
    </div>
  );
}
