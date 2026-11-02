import { Show, Switch, Match } from 'solid-js';
import { theme } from '../../lib/theme';
import {
  store,
  setAutoTrustFolders,
  setDesktopNotificationsEnabled,
  setEditorCommand,
  setVerboseLogging,
  updateStatus,
  checkForUpdates,
} from '../../store/store';
import { setFeatureHintsEnabled } from '../../store/onboarding';
import { SuperProductivitySettings } from '../SuperProductivitySettings';
import { SyncIcon } from '../icons';
import {
  SettingsCard,
  SettingsCheckboxRow,
  SettingsSection,
  settingsFieldStyle,
} from './settings-ui';

export function GeneralSettings() {
  // Styles shared across the Updates section's rows, buttons and messages.
  const updateRowStyle = {
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'space-between',
    gap: '12px',
  };
  const updateSecondaryButtonStyle = (disabled: boolean) => ({
    padding: '6px 12px',
    'border-radius': 'var(--radius-sm)',
    border: `1px solid ${theme.border}`,
    background: theme.bgElevated,
    color: theme.fg,
    'font-size': '13px',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? '0.6' : '1',
  });
  const updateMessageStyle = (color: string) => ({ 'font-size': '12px', color });

  // Phases that permit a manual check. An allow-list keeps a future phase
  // from defaulting to "shown" the way excluding non-checkable phases would.
  const canCheckForUpdates = () =>
    ['idle', 'checking', 'up-to-date', 'available', 'error'].includes(updateStatus().phase);
  return (
    <>
      <SettingsSection title="Behavior">
        <SettingsCheckboxRow
          label="Auto-trust folders"
          checked={store.autoTrustFolders}
          onChange={setAutoTrustFolders}
          description="Automatically accept trust and permission dialogs from agents"
        />
        <SettingsCheckboxRow
          label="Desktop notifications"
          checked={store.desktopNotificationsEnabled}
          onChange={setDesktopNotificationsEnabled}
          description="Show native notifications when tasks finish or need attention"
        />
        <SettingsCheckboxRow
          label="Show feature tips"
          checked={store.featureHintsEnabled}
          onChange={setFeatureHintsEnabled}
          description="One-time tips when a feature first becomes useful, such as change tours. Turning this on shows every tip again"
        />
      </SettingsSection>
      <SettingsSection title="Editor">
        <SettingsCard>
          <label
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '10px',
            }}
          >
            <span style={{ 'font-size': '14px', color: theme.fg, 'white-space': 'nowrap' }}>
              Editor command
            </span>
            <input
              type="text"
              value={store.editorCommand}
              onInput={(e) => setEditorCommand(e.currentTarget.value)}
              placeholder="e.g. code, cursor, zed, subl"
              style={{
                flex: '1',
                ...settingsFieldStyle,
                'font-size': '14px',
                'font-family': "'JetBrains Mono', monospace",
              }}
            />
          </label>
          <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
            CLI command to open worktree folders. Click the path bar in a task to open it.
          </span>
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Super Productivity">
        <SuperProductivitySettings />
      </SettingsSection>
      <SettingsSection title="Diagnostics">
        <SettingsCheckboxRow
          label="Verbose logging"
          checked={store.verboseLogging}
          onChange={setVerboseLogging}
          description="Emit debug-level logs to the developer console. Verbose logs may include file paths, branch names, commit messages, IPC channel activity, and pty lifecycle events. Review the contents before sharing."
        />
      </SettingsSection>
      <SettingsSection title="Updates">
        <SettingsCard gap="10px">
          <div style={updateRowStyle}>
            <span style={{ 'font-size': '14px', color: theme.fg }}>
              Current version
              <Show when={updateStatus().currentVersion}>
                {' '}
                <span style={{ color: theme.fgMuted }}>v{updateStatus().currentVersion}</span>
              </Show>
            </span>
            <Show when={canCheckForUpdates()}>
              <button
                type="button"
                class="btn-with-icon"
                disabled={updateStatus().phase === 'checking'}
                onClick={() => void checkForUpdates()}
                style={updateSecondaryButtonStyle(updateStatus().phase === 'checking')}
              >
                <SyncIcon size={14} />
                {updateStatus().phase === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>
            </Show>
          </div>

          <Switch>
            <Match when={updateStatus().phase === 'unsupported'}>
              <span style={updateMessageStyle(theme.fgSubtle)}>
                Automatic updates are not available for this build. Download the latest release from
                GitHub to update.
              </span>
            </Match>

            <Match when={updateStatus().phase === 'up-to-date'}>
              <span style={updateMessageStyle(theme.fgSubtle)}>You are on the latest version.</span>
            </Match>

            <Match when={updateStatus().phase === 'available'}>
              <span style={updateMessageStyle(theme.fg)}>
                Version {updateStatus().latestVersion} is available. Use the update button in the
                sidebar to install.
              </span>
            </Match>

            <Match when={updateStatus().phase === 'downloading'}>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                <span style={updateMessageStyle(theme.fgSubtle)}>
                  Downloading update… {updateStatus().downloadPercent}%
                </span>
                <div
                  style={{
                    height: '6px',
                    'border-radius': 'var(--radius-xs)',
                    background: theme.bgElevated,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${updateStatus().downloadPercent}%`,
                      background: theme.accent,
                      transition: 'width 0.2s',
                    }}
                  />
                </div>
              </div>
            </Match>

            <Match when={updateStatus().phase === 'downloaded'}>
              <span style={updateMessageStyle(theme.fg)}>
                Version {updateStatus().latestVersion} is downloaded. Use the update button in the
                sidebar to restart &amp; install.
              </span>
            </Match>

            <Match when={updateStatus().phase === 'error'}>
              <span style={updateMessageStyle(theme.error)}>
                Update check failed: {updateStatus().error}
              </span>
            </Match>
          </Switch>
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
