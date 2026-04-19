import { Show } from 'solid-js';
import { theme } from '../lib/theme';

interface TaskClosingOverlayProps {
  closingStatus: string | undefined;
  closingError: string | undefined;
  onRetry: () => void;
}

export function TaskClosingOverlay(props: TaskClosingOverlayProps) {
  return (
    <Show when={props.closingStatus && props.closingStatus !== 'removing'}>
      <div
        style={{
          position: 'absolute',
          inset: '0',
          'z-index': '50',
          background: 'rgba(0, 0, 0, 0.6)',
          display: 'flex',
          'flex-direction': 'column',
          'align-items': 'center',
          'justify-content': 'center',
          gap: '12px',
          'border-radius': '12px',
          color: theme.fg,
        }}
      >
        <Show when={props.closingStatus === 'closing'}>
          <div style={{ 'font-size': '14px', color: theme.fgMuted }}>Closing task...</div>
        </Show>
        <Show when={props.closingStatus === 'error'}>
          <div style={{ 'font-size': '14px', color: theme.error, 'font-weight': '600' }}>
            Close failed
          </div>
          <div
            style={{
              'font-size': '12px',
              color: theme.fgMuted,
              'max-width': '260px',
              'text-align': 'center',
              'word-break': 'break-word',
            }}
          >
            {props.closingError}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              props.onRetry();
            }}
            style={{
              background: theme.bgElevated,
              border: `1px solid ${theme.border}`,
              color: theme.fg,
              padding: '6px 16px',
              'border-radius': '6px',
              cursor: 'pointer',
              'font-size': '13px',
            }}
          >
            Retry
          </button>
        </Show>
      </div>
    </Show>
  );
}
