// Sidebar-header update affordance. Stays hidden until the backend updater
// reports a newer version, then surfaces the one action that phase allows:
// download when available, restart-and-install once downloaded. While a
// download is in flight it shows percent and is non-interactive.
//
// The detailed status (current version, manual check, "up to date", errors)
// still lives in Settings → Diagnostics → Updates; this button is only the
// at-a-glance signal so an available update is discoverable without opening
// Settings.

import { Show } from 'solid-js';
import { theme } from '../lib/theme';
import { updateStatus, downloadUpdate, installUpdate } from '../store/store';
import { DownloadIcon, RefreshIcon } from './icons';

export function UpdateButton() {
  const phase = () => updateStatus().phase;
  const version = () => updateStatus().latestVersion;
  const visible = () =>
    phase() === 'available' || phase() === 'downloading' || phase() === 'downloaded';

  const title = () => {
    const v = version() ? ` ${version()}` : '';
    if (phase() === 'downloading') return `Downloading update… ${updateStatus().downloadPercent}%`;
    if (phase() === 'downloaded') return `Restart & install update${v}`;
    return `Download update${v}`;
  };

  const handleClick = () => {
    if (phase() === 'available') downloadUpdate();
    else if (phase() === 'downloaded') installUpdate();
    // 'downloading' — no action; the button is a progress indicator.
  };

  return (
    <Show when={visible()}>
      <button
        class="icon-btn"
        title={title()}
        aria-label={title()}
        onClick={(e) => {
          e.stopPropagation();
          handleClick();
        }}
        style={{
          background: phase() === 'downloading' ? 'transparent' : theme.accent,
          border: `1px solid ${theme.accent}`,
          color: phase() === 'downloading' ? theme.accent : theme.accentText,
          cursor: phase() === 'downloading' ? 'default' : 'pointer',
          'border-radius': 'var(--radius-sm)',
          padding: '4px',
          'font-size': '13px',
          'line-height': '1',
          'flex-shrink': '0',
          display: 'inline-flex',
          'align-items': 'center',
          'justify-content': 'center',
          'min-width': '24px',
        }}
      >
        <Show
          when={phase() === 'downloading'}
          fallback={phase() === 'downloaded' ? <RefreshIcon /> : <DownloadIcon />}
        >
          <span style={{ 'font-size': '11px', 'font-weight': '600' }}>
            {updateStatus().downloadPercent}%
          </span>
        </Show>
      </button>
    </Show>
  );
}
