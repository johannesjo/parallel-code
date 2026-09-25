import { createSignal, onMount, Show, type JSX } from 'solid-js';
import {
  connectSuperProductivity,
  disconnectSuperProductivity,
  refreshSpConnection,
  spConnection,
} from '../store/store';
import { theme } from '../lib/theme';
import { errMessage } from '../lib/log';
import type { SpConnectionState } from '../../electron/shared/super-productivity';

/** IPC errors arrive as "Error invoking remote method '…': Error: <message>". */
function readableError(err: unknown): string {
  return errMessage(err)
    .replace(/^Error invoking remote method '[^']*': /, '')
    .replace(/^Error: /, '');
}

const STATUS_TEXT: Record<SpConnectionState, string> = {
  not_configured: 'Not connected',
  connected: 'Connected',
  // Super Productivity stops listening when its API is off, so a never-enabled
  // API looks exactly like the app not running.
  unreachable: 'Not reachable — is Super Productivity running, with its Local REST API turned on?',
  disabled: 'The Local REST API is turned off in Super Productivity',
  unauthorized: 'Super Productivity rejected the token — paste the current one',
  not_ready: 'Super Productivity is still starting',
};

const buttonStyle = (primary: boolean): JSX.CSSProperties => ({
  padding: '6px 14px',
  background: primary ? theme.accent : 'transparent',
  border: primary ? 'none' : `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-sm)',
  color: primary ? theme.accentText : theme.fgMuted,
  cursor: 'pointer',
  'font-size': '13px',
});

/**
 * Connection to Super Productivity's Local REST API. The token is handed to
 * the main process and never read back.
 */
export function SuperProductivitySettings() {
  const [token, setToken] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  onMount(() => void refreshSpConnection());

  async function run(action: () => Promise<unknown>): Promise<void> {
    if (busy()) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  function connect(e: Event) {
    e.preventDefault();
    const value = token().trim();
    if (!value) return;
    void run(async () => {
      await connectSuperProductivity(value);
      setToken('');
    });
  }

  const statusColor = () => {
    const state = spConnection();
    if (state === 'connected') return theme.success;
    return state === 'not_configured' ? theme.fgMuted : theme.warning;
  };
  // Asking for a token only makes sense when there is none or it was rejected;
  // for the other states the token is not the problem.
  const needsToken = () => {
    const state = spConnection();
    return state === 'not_configured' || state === 'unauthorized';
  };

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      <div style={{ 'font-size': '12px', color: theme.fgSubtle, 'line-height': '1.5' }}>
        Track time in Super Productivity on the task you focus here (creating a task there when
        needed), keep task titles in sync, and mark tasks done when you merge or close them. In
        Super Productivity, turn on <strong>Settings → Misc → Local REST API</strong> and paste its
        access token below.
      </div>
      <div role="status" style={{ 'font-size': '12px', color: statusColor() }}>
        {busy() ? 'Checking…' : STATUS_TEXT[spConnection()]}
      </div>
      <Show when={needsToken()}>
        <form style={{ display: 'flex', gap: '8px' }} onSubmit={connect}>
          <input
            type="password"
            autocomplete="off"
            spellcheck={false}
            placeholder="Access token"
            aria-label="Super Productivity access token"
            value={token()}
            onInput={(e) => {
              setToken(e.currentTarget.value);
              setError('');
            }}
            style={{
              flex: '1',
              padding: '6px 8px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-sm)',
              color: theme.fg,
              'font-size': '12px',
              'font-family': "'JetBrains Mono', monospace",
            }}
          />
          <button
            type="submit"
            class="btn-primary"
            disabled={busy() || !token().trim()}
            style={{ ...buttonStyle(true), opacity: busy() || !token().trim() ? 0.5 : 1 }}
          >
            {spConnection() === 'not_configured' ? 'Connect' : 'Replace token'}
          </button>
        </form>
      </Show>
      <Show when={spConnection() !== 'not_configured'}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            class="btn-secondary"
            disabled={busy()}
            style={buttonStyle(false)}
            onClick={() => void run(refreshSpConnection)}
          >
            Check again
          </button>
          <button
            type="button"
            class="btn-secondary"
            disabled={busy()}
            style={buttonStyle(false)}
            onClick={() => void run(disconnectSuperProductivity)}
          >
            Disconnect
          </button>
        </div>
      </Show>
      <Show when={error()}>
        <div role="alert" style={{ 'font-size': '12px', color: theme.error }}>
          {error()}
        </div>
      </Show>
    </div>
  );
}
