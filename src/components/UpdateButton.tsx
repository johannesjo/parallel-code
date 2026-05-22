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

const DownloadIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M8 2v8" />
    <path d="M4.5 7 8 10.5 11.5 7" />
    <path d="M3 13h10" />
  </svg>
);

const RestartIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M13 8a5 5 0 1 1-1.46-3.54" />
    <path d="M13 2v3h-3" />
  </svg>
);

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
          'border-radius': '6px',
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
          fallback={phase() === 'downloaded' ? <RestartIcon /> : <DownloadIcon />}
        >
          <span style={{ 'font-size': '10px', 'font-weight': '600' }}>
            {updateStatus().downloadPercent}%
          </span>
        </Show>
      </button>
    </Show>
  );
}
