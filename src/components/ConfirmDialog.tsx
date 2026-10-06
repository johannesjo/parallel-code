import { Show, createEffect, createUniqueId, type JSX } from 'solid-js';
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
  /** Short text at the start of the footer, e.g. why the confirm button is disabled. */
  footerNote?: string;
  /** Further buttons between Cancel and the confirm button, e.g. an alternative action. */
  extraActions?: JSX.Element;
  /** When set, takes precedence over the auto-generated title id. */
  labelledBy?: string;
  describedBy?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  let cancelRef: HTMLButtonElement | undefined;
  const generatedTitleId = createUniqueId();
  const useGeneratedId = () => props.labelledBy === undefined;

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
    <Dialog
      open={props.open}
      onClose={props.onCancel}
      width={props.width}
      labelledBy={props.labelledBy ?? generatedTitleId}
      describedBy={props.describedBy}
    >
      <h2
        id={useGeneratedId() ? generatedTitleId : undefined}
        style={{
          'flex-shrink': '0',
          margin: '0',
          'font-size': '17px',
          color: theme.fg,
          'font-weight': '600',
        }}
      >
        {props.title}
      </h2>

      {/* Only the message scrolls; title and buttons stay in view, so a long
          dialog never hides its actions. */}
      <div
        data-dialog-scroll
        style={{
          flex: '1 1 auto',
          'min-height': '0',
          'overflow-y': 'auto',
          // Reach into the panel's 28px padding so the scrollbar sits at its
          // edge while the content keeps its alignment with the title.
          'margin-right': '-24px',
          'padding-right': '24px',
          'font-size': '14px',
          color: theme.fgMuted,
          'line-height': '1.5',
        }}
      >
        {props.message}
      </div>

      <div
        style={{
          'flex-shrink': '0',
          display: 'flex',
          gap: '8px',
          'justify-content': 'flex-end',
          'padding-top': '4px',
        }}
      >
        <Show when={props.footerNote}>
          <span
            style={{
              'margin-right': 'auto',
              'align-self': 'center',
              'min-width': '0',
              color: theme.fgMuted,
              'font-size': '12px',
            }}
          >
            {props.footerNote}
          </span>
        </Show>
        <button
          ref={cancelRef}
          type="button"
          class="btn-secondary"
          onClick={() => props.onCancel()}
          style={{
            padding: '9px 18px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            'border-radius': 'var(--radius-md)',
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-size': '14px',
          }}
        >
          {props.cancelLabel ?? 'Cancel'}
        </button>
        {props.extraActions}
        <button
          type="button"
          class={props.danger ? 'btn-danger' : 'btn-primary'}
          disabled={props.confirmDisabled}
          onClick={() => props.onConfirm()}
          style={{
            padding: '9px 20px',
            background: props.danger ? theme.error : theme.accent,
            border: 'none',
            'border-radius': 'var(--radius-md)',
            color: props.danger ? '#fff' : theme.accentText,
            cursor: props.confirmDisabled ? 'not-allowed' : 'pointer',
            'font-size': '14px',
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
