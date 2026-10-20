import { Show, createSignal, createUniqueId, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { sf } from '../lib/fontScale';
import { createAnchorEffect, placeBelow, type BelowAnchor } from '../lib/floating';
import { theme } from '../lib/theme';

const WIDTH = 340;

/**
 * Explains the wrapped control on hover or keyboard focus. Read-only on
 * purpose: it ignores the pointer, so it never blocks the control it explains.
 */
export function HelpPopover(props: { content: JSX.Element; children: JSX.Element }) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal<BelowAnchor>({ top: 0, right: 0, maxHeight: 320 });
  let anchor: HTMLSpanElement | undefined;
  createAnchorEffect(open, () => {
    if (!anchor) return;
    setPosition(
      placeBelow(
        anchor.getBoundingClientRect(),
        Math.min(WIDTH, window.innerWidth - 24),
        { width: window.innerWidth, height: window.innerHeight },
        12,
        320,
      ),
    );
  });

  return (
    <span
      ref={anchor}
      aria-describedby={open() ? id : undefined}
      style={{ display: 'inline-flex' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusIn={() => setOpen(true)}
      onFocusOut={() => setOpen(false)}
      onKeyDown={(event) => {
        // Escape hides the help first; the dialog around it closes on the next press.
        if (event.key === 'Escape' && open()) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {props.children}
      <Show when={open()}>
        <Portal>
          <div
            id={id}
            role="tooltip"
            style={{
              position: 'fixed',
              top: `${position().top}px`,
              right: `${position().right}px`,
              width: `${WIDTH}px`,
              'max-width': 'calc(100vw - 24px)',
              'max-height': `${position().maxHeight}px`,
              'box-sizing': 'border-box',
              overflow: 'auto',
              'pointer-events': 'none',
              'z-index': '2000',
              padding: '12px 14px',
              background: theme.bgElevated,
              color: theme.fg,
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-sm)',
              'box-shadow': '0 4px 16px rgba(0, 0, 0, 0.3)',
              'font-size': sf(12),
              'line-height': '1.5',
            }}
          >
            {props.content}
          </div>
        </Portal>
      </Show>
    </span>
  );
}
