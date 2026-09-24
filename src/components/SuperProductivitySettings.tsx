import { createSignal, onMount, Show } from 'solid-js';
import {
  connectSuperProductivity,
  disconnectSuperProductivity,
  refreshSpConnection,
  spConnection,
} from '../store/store';
import { theme } from '../lib/theme';
import { errMessage } from '../lib/log';
import type { SpConnectionState } from '../../electron/shared/super-productivity';

const STATUS_TEXT: Record<SpConnectionState, string> = {
  not_configured: 'Not connected',
  connected: 'Connected',
  unreachable: 'Not reachable — is Super Productivity running?',
  disabled: 'The Local REST API is turned off in Super Productivity',
  unauthorized: 'Super Productivity rejected the token',
  not_ready: 'Super Productivity is still starting',
};

/**
 * Connection to Super Productivity's Local REST API. The token is handed to
 * the main process and never read back.
 */
export function SuperProductivitySettings() {
  const [token, setToken] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  onMount(() => void refreshSpConnection());

  async function connect(e: Event) {
    e.preventDefault();
    if (!token().trim() || busy()) return;
    setBusy(true);
    setError('');
    try {
      await connectSuperProductivity(token().trim());
      setToken('');
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      await disconnectSuperProductivity();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const statusColor = () => {
    const state = spConnection();
    if (state === 'connected') return theme.success;
    return state === 'not_configured' ? theme.fgMuted : theme.warning;
  };

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      <div style={{ 'font-size': '12px', color: theme.fgSubtle, 'line-height': '1.5' }}>
        Track time in Super Productivity on the task you focus here, keep task titles in sync, and
        mark tasks done when you merge or close them. In Super Productivity, turn on{' '}
        <strong>Settings → Misc → Local REST API</strong> and paste its access token below.
      </div>
      <div style={{ 'font-size': '12px', color: statusColor() }}>{STATUS_TEXT[spConnection()]}</div>
      <Show when={spConnection() !== 'connected'}>
        <form style={{ display: 'flex', gap: '8px' }} onSubmit={(e) => void connect(e)}>
          <input
            type="password"
            autocomplete="off"
            spellcheck={false}
            placeholder="Access token"
            aria-label="Super Productivity access token"
            value={token()}
            onInput={(e) => setToken(e.currentTarget.value)}
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
          <button type="submit" class="btn-primary" disabled={busy() || !token().trim()}>
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
            onClick={() => void refreshSpConnection()}
          >
            Check again
          </button>
          <button
            type="button"
            class="btn-secondary"
            disabled={busy()}
            onClick={() => void disconnect()}
          >
            Disconnect
          </button>
        </div>
      </Show>
      <Show when={error()}>
        <div style={{ 'font-size': '12px', color: theme.error }}>{error()}</div>
      </Show>
    </div>
  );
}
