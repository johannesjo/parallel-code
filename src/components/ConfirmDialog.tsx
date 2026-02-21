import { Show, createEffect, type JSX } from 'solid-js';
import { Dialog } from './Dialog';
import { theme } from '../lib/theme';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string | JSX.Element;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmLoading?: boolean;
  danger?: boolean;
  confirmDisabled?: boolean;
  autoFocusCancel?: boolean;
  width?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  let cancelRef: HTMLButtonElement | undefined;

  // Auto-focus the cancel button (or let Dialog's panel get focus)
  createEffect(() => {
    if (!props.open) return;
    const focusCancelBtn = props.autoFocusCancel ?? true;

    // Blur whatever is focused outside the dialog (e.g. the button that
    // triggered this dialog) so our programmatic focus call sticks.
    (document.activeElement as HTMLElement)?.blur?.();

    // Focus the cancel button after the Dialog panel renders.
    requestAnimationFrame(() => {
      if (focusCancelBtn) cancelRef?.focus();
    });
  });

  return (
    <Dialog open={props.open} onClose={props.onCancel} width={props.width}>
      <h2
        style={{
          margin: '0',
          'font-size': '16px',
          color: theme.fg,
          'font-weight': '600',
        }}
      >
        {props.title}
      </h2>

      <div style={{ 'font-size': '13px', color: theme.fgMuted, 'line-height': '1.5' }}>
        {props.message}
      </div>

      <div
        style={{
          display: 'flex',
          gap: '8px',
          'justify-content': 'flex-end',
          'padding-top': '4px',
        }}
      >
        <button
          ref={cancelRef}
          type="button"
          class="btn-secondary"
          onClick={() => props.onCancel()}
          style={{
            padding: '9px 18px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            'border-radius': '8px',
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-size': '13px',
          }}
        >
          {props.cancelLabel ?? 'Cancel'}
        </button>
        <button
          type="button"
          class={props.danger ? 'btn-danger' : 'btn-primary'}
          disabled={props.confirmDisabled}
          onClick={() => props.onConfirm()}
          style={{
            padding: '9px 20px',
            background: props.danger ? theme.error : theme.accent,
            border: 'none',
            'border-radius': '8px',
            color: props.danger ? '#fff' : theme.accentText,
            cursor: props.confirmDisabled ? 'not-allowed' : 'pointer',
            'font-size': '13px',
            'font-weight': '500',
            opacity: props.confirmDisabled ? '0.5' : '1',
            display: 'inline-flex',
            'align-items': 'center',
            gap: '8px',
          }}
        >
          <Show when={props.confirmLoading}>
            <span class="inline-spinner" aria-hidden="true" />
          </Show>
          {props.confirmLabel ?? 'Confirm'}
        </button>
      </div>
    </Dialog>
  );
}
