import { onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { DocumentIcon } from '../documents/DocumentIcon';

export type ProjectKindChoice = 'code' | 'document';

interface AddProjectMenuProps {
  /** Viewport coordinates of the "+" button this hangs from. */
  anchor: { left: number; top: number };
  onPick: (kind: ProjectKindChoice) => void;
  onClose: () => void;
}

const MENU_WIDTH = 232;

/**
 * The two project kinds, offered rather than asked. This replaces a native
 * message box: that blocked the window to pose a question in a dialog system
 * the app does not control, and its Escape cancelled the whole add instead of
 * backing out of the question.
 */
export function AddProjectMenu(props: AddProjectMenuProps) {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => window.removeEventListener('keydown', onKey, true));
  });

  const row = (kind: ProjectKindChoice, icon: () => unknown, label: string, hint: string) => (
    <button
      type="button"
      onClick={() => props.onPick(kind)}
      style={{
        display: 'flex',
        'align-items': 'flex-start',
        gap: '9px',
        padding: '8px 10px',
        background: 'transparent',
        border: 'none',
        'border-radius': 'var(--radius-sm)',
        color: theme.fg,
        cursor: 'pointer',
        'text-align': 'left',
        font: 'inherit',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = theme.bgHover)}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ color: theme.fgMuted, 'margin-top': '1px', 'flex-shrink': '0' }}>
        {icon() as never}
      </span>
      <span style={{ display: 'flex', 'flex-direction': 'column', gap: '1px', 'min-width': '0' }}>
        <span style={{ 'font-size': sf(12), 'font-weight': '500' }}>{label}</span>
        <span style={{ 'font-size': sf(11), color: theme.fgMuted }}>{hint}</span>
      </span>
    </button>
  );

  return (
    <Portal>
      <div
        onClick={() => props.onClose()}
        onContextMenu={() => props.onClose()}
        style={{ position: 'fixed', inset: '0', 'z-index': '1200' }}
      >
        <div
          role="menu"
          aria-label="Add project"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: `${props.anchor.left}px`,
            top: `${props.anchor.top}px`,
            width: `${MENU_WIDTH}px`,
            background: theme.bgElevated,
            border: `1px solid ${theme.border}`,
            'border-radius': 'var(--radius-md)',
            'box-shadow': '0 6px 20px rgba(0, 0, 0, 0.35)',
            padding: '4px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '1px',
          }}
        >
          {row(
            'code',
            () => (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1.5 3.25A1.75 1.75 0 0 1 3.25 1.5h2.9c.46 0 .9.18 1.23.51l.86.86h4.51c.97 0 1.75.78 1.75 1.75v7.63c0 .97-.78 1.75-1.75 1.75H3.25a1.75 1.75 0 0 1-1.75-1.75z" />
              </svg>
            ),
            'Code project…',
            'A git repo that holds tasks',
          )}
          {row(
            'document',
            () => (
              <DocumentIcon size={14} />
            ),
            'Document project…',
            'A folder with one Markdown document',
          )}
        </div>
      </div>
    </Portal>
  );
}
