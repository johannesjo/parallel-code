import { Show, createEffect, onCleanup, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { createFocusRestore } from '../lib/focus-restore';
import { createFocusTrap } from '../lib/focus-trap';
import { theme } from '../lib/theme';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  width?: string;
  zIndex?: number;
  panelStyle?: JSX.CSSProperties;
  children: JSX.Element;
}

export function Dialog(props: DialogProps) {
  let panelRef: HTMLDivElement | undefined;

  createFocusRestore(() => props.open);
  createFocusTrap(
    () => props.open,
    () => panelRef,
  );

  // Escape key → close
  createEffect(() => {
    if (!props.open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', handler);
    onCleanup(() => document.removeEventListener('keydown', handler));
  });

  function handlePanelKeyDown(e: KeyboardEvent) {
    if (!panelRef) return;
    const step = 40;
    const page = 200;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      panelRef.scrollTop += step;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      panelRef.scrollTop -= step;
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      panelRef.scrollTop += page;
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      panelRef.scrollTop -= page;
    }
  }

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
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) props.onClose();
          }}
        >
          <div
            ref={panelRef}
            tabIndex={0}
            onKeyDown={handlePanelKeyDown}
            class="dialog-panel"
            style={{
              background: theme.islandBg,
              border: `1px solid ${theme.border}`,
              'border-radius': '14px',
              padding: '28px',
              width: props.width ?? '400px',
              'max-height': '80vh',
              overflow: 'auto',
              display: 'flex',
              'flex-direction': 'column',
              gap: '16px',
              outline: 'none',
              'box-shadow':
                '0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset',
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
