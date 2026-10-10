import { createMemo, createEffect, createSignal, onCleanup, Show } from 'solid-js';
import {
  store,
  getMergedTasksTodayCount,
  toggleHelpDialog,
  toggleArena,
  hasAnyCoordinatorTask,
  startMCPStatusPolling,
  stopMCPStatusPolling,
} from '../store/store';
import { theme } from '../lib/theme';
import { alt, mod } from '../lib/platform';
import { KeyboardIcon, PhoneIcon, ScrambleIcon } from './icons';

/** Compact utilities and optional activity totals, shared by every theme. */
export function SidebarFooter(props: { onConnectPhone: () => void }) {
  const [clock, setClock] = createSignal(Date.now());
  const dayTimer = setInterval(() => setClock(Date.now()), 60_000);
  onCleanup(() => clearInterval(dayTimer));
  const mergedTasksToday = createMemo(() => {
    clock();
    return getMergedTasksTodayCount();
  });
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
    <div class="sidebar-footer">
      <Show when={hasCoordinator()}>
        <div class="sidebar-footer-connection">
          <div
            style={{
              width: '8px',
              height: '8px',
              'border-radius': '50%',
              background: mcpOk() ? theme.success : theme.error,
              'flex-shrink': '0',
            }}
          />
          <span>MCP {mcpOk() ? 'Connected' : 'Disconnected'}</span>
        </div>
      </Show>

      <div class="sidebar-footer-tools">
        <h2 class="sidebar-footer-heading">Workspace</h2>
        <div class="sidebar-footer-actions">
          <button
            onClick={() => props.onConnectPhone()}
            title={
              phoneConnected()
                ? 'Phone connected: manage remote access'
                : 'Connect a phone for remote access'
            }
            type="button"
            class="sidebar-footer-action"
            aria-label={
              phoneConnected() ? 'Phone connected: manage remote access' : 'Connect phone'
            }
          >
            <PhoneIcon size={14} />
            <span>Phone access</span>
            <Show when={phoneConnected()}>
              <span class="sidebar-footer-connected-dot" aria-hidden="true" />
            </Show>
          </button>
          <button
            onClick={() => toggleArena(true)}
            title="Arena: run two agents on the same prompt and compare"
            type="button"
            class="sidebar-footer-action"
          >
            <ScrambleIcon size={14} />
            Arena
          </button>

          <Show when={store.showSidebarTips}>
            <button
              type="button"
              class="sidebar-footer-action sidebar-footer-shortcuts"
              onClick={() => toggleHelpDialog(true)}
              title={`Keyboard shortcuts (${mod}+/). Switch panels with ${alt}+Arrows.`}
            >
              <span class="sidebar-footer-action-label">
                <KeyboardIcon size={14} />
                Shortcuts
              </span>
              <kbd>{mod} /</kbd>
            </button>
          </Show>
        </div>
      </div>

      <Show when={store.showSidebarProgress && mergedTasksToday() > 0}>
        <div class="sidebar-footer-progress">
          <div class="sidebar-footer-stat" title="Local task merges and tracked PRs merged today">
            <span>Merged today</span>
            <strong>{mergedTasksToday()}</strong>
          </div>
        </div>
      </Show>
    </div>
  );
}
