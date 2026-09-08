import { For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { getStatusColor } from '../lib/status-colors';
import type { ChangedFile } from '../ipc/types';

export const POPOVER_WIDTH = 300;
export const POPOVER_MAX_HEIGHT = 260;

// Cap the rendered rows to what fits in POPOVER_MAX_HEIGHT and summarize the
// rest. The popover is pointer-events:none (glance-only), so it cannot scroll —
// without the cap a large commit would silently clip its tail.
const MAX_VISIBLE_FILES = 12;

interface CommitFilesPopoverProps {
  pos: { left: number; top: number; hash: string };
  files: ChangedFile[] | undefined;
}

/** Floating, glance-only list of files touched by the hovered commit. */
export function CommitFilesPopover(props: CommitFilesPopoverProps) {
  return (
    <Portal>
      <div
        style={{
          position: 'fixed',
          left: `${props.pos.left}px`,
          top: `${props.pos.top}px`,
          width: `${POPOVER_WIDTH}px`,
          'max-height': `${POPOVER_MAX_HEIGHT}px`,
          overflow: 'hidden',
          'pointer-events': 'none',
          'z-index': '1000',
          background: theme.bgElevated,
          border: `1px solid ${theme.border}`,
          'border-radius': 'var(--radius-sm)',
          'box-shadow': '0 4px 16px rgba(0, 0, 0, 0.3)',
          padding: '6px',
          'font-size': sf(11),
          display: 'flex',
          'flex-direction': 'column',
          gap: '2px',
        }}
      >
        <Show when={props.files} fallback={<div style={{ color: theme.fgMuted }}>Loading…</div>}>
          {(files) => (
            <Show
              when={files().length > 0}
              fallback={<div style={{ color: theme.fgMuted }}>No files touched.</div>}
            >
              <div
                style={{
                  color: theme.fgMuted,
                  'font-weight': '600',
                  'text-transform': 'uppercase',
                  'letter-spacing': '0.05em',
                  'font-size': sf(11),
                  'margin-bottom': '2px',
                }}
              >
                {files().length} file{files().length === 1 ? '' : 's'}
              </div>
              <For each={files().slice(0, MAX_VISIBLE_FILES)}>
                {(file) => (
                  <div
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '6px',
                      'white-space': 'nowrap',
                      overflow: 'hidden',
                      'font-family': "'JetBrains Mono', monospace",
                    }}
                  >
                    <span
                      style={{
                        color: getStatusColor(file.status.charAt(0)),
                        'font-weight': '600',
                        'flex-shrink': '0',
                        width: '12px',
                      }}
                    >
                      {file.status.charAt(0)}
                    </span>
                    <span
                      style={{
                        color: theme.fg,
                        flex: '1',
                        'min-width': '0',
                        overflow: 'hidden',
                        'text-overflow': 'ellipsis',
                      }}
                    >
                      {file.path}
                    </span>
                    <Show when={file.lines_added > 0 || file.lines_removed > 0}>
                      <span style={{ color: theme.success, 'flex-shrink': '0' }}>
                        +{file.lines_added}
                      </span>
                      <span style={{ color: theme.error, 'flex-shrink': '0' }}>
                        -{file.lines_removed}
                      </span>
                    </Show>
                  </div>
                )}
              </For>
              <Show when={files().length > MAX_VISIBLE_FILES}>
                <div style={{ color: theme.fgMuted, 'font-size': sf(11), 'margin-top': '2px' }}>
                  +{files().length - MAX_VISIBLE_FILES} more
                </div>
              </Show>
            </Show>
          )}
        </Show>
      </div>
    </Portal>
  );
}
