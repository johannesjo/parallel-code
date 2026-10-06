import { Show, createEffect, createUniqueId, onCleanup, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { createFocusRestore } from '../lib/focus-restore';
import { createFocusTrap } from '../lib/focus-trap';
import { isTopmost, popDialog, pushDialog } from '../lib/dialog-stack';
import { theme } from '../lib/theme';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  width?: string;
  zIndex?: number;
  panelStyle?: JSX.CSSProperties;
  /** Overrides on the backdrop, e.g. a top inset that keeps the window chrome reachable. */
  overlayStyle?: JSX.CSSProperties;
  /** Element id whose text labels this dialog (sets aria-labelledby). */
  labelledBy?: string;
  /** Element id (or space-separated list) describing this dialog (aria-describedby). */
  describedBy?: string;
  children: JSX.Element;
}

export function Dialog(props: DialogProps) {
  let panelRef: HTMLDivElement | undefined;
  const dialogId = createUniqueId();

  createFocusRestore(() => props.open);
  // Only the topmost dialog traps Tab. Two live traps fight over every press:
  // the lower one moves focus into its own panel, then the upper one sees focus
  // outside itself and resets to its first control, so Tab never advances.
  createFocusTrap(
    () => props.open && isTopmost(dialogId),
    () => panelRef,
  );

  // Register / unregister with the global dialog stack so only the
  // topmost panel claims aria-modal.
  createEffect(() => {
    if (!props.open) return;
    pushDialog(dialogId);
    onCleanup(() => popDialog(dialogId));
  });

  // Escape closes only the topmost dialog.
  createEffect(() => {
    if (!props.open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!isTopmost(dialogId)) return;
      e.stopPropagation();
      props.onClose();
    };
    document.addEventListener('keydown', handler);
    onCleanup(() => document.removeEventListener('keydown', handler));
  });

  // Scroll the panel with arrow/page keys, but ONLY when the panel itself
  // is focused — not when events bubble from interactive children like
  // <select>, <input>, etc.  We use a native listener (not SolidJS delegation)
  // so we can check e.target reliably.
  createEffect(() => {
    if (!props.open) return;
    const el = panelRef;
    if (!el) return;

    const step = 40;
    const page = 200;
    const handler = (e: KeyboardEvent) => {
      if (e.target !== el) return;
      // A dialog with a pinned footer scrolls an inner region, not the panel.
      const target = el.querySelector<HTMLElement>('[data-dialog-scroll]') ?? el;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        target.scrollTop += step;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        target.scrollTop -= step;
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        target.scrollTop += page;
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        target.scrollTop -= page;
      }
    };
    el.addEventListener('keydown', handler);
    onCleanup(() => el.removeEventListener('keydown', handler));
  });

  return (
    <Portal>
      <Show when={props.open}>
        <div
          class="dialog-overlay"
          style={{
            position: 'fixed',
            inset: '0',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            background: 'rgba(0,0,0,0.55)',
            'z-index': String(props.zIndex ?? 1000),
            ...props.overlayStyle,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) props.onClose();
          }}
        >
          <div
            ref={panelRef}
            tabIndex={0}
            role="dialog"
            aria-modal={isTopmost(dialogId) ? 'true' : undefined}
            aria-labelledby={props.labelledBy}
            aria-describedby={props.describedBy}
            class="dialog-panel"
            style={{
              background: theme.islandBg,
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-lg)',
              padding: '28px',
              width: props.width ?? '400px',
              'max-height': '80vh',
              overflow: 'auto',
              display: 'flex',
              'flex-direction': 'column',
              gap: '16px',
              outline: 'none',
              'box-shadow':
                '0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px color-mix(in srgb, var(--fg) 3%, transparent) inset',
              ...props.panelStyle,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {props.children}
          </div>
        </div>
      </Show>
    </Portal>
  );
}
