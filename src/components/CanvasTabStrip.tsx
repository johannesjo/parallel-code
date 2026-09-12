import { For, Show, createSignal } from 'solid-js';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { canvasTabKey } from '../lib/canvas-tabs';
import type { CanvasTab, CanvasTabKind } from '../store/types';
import { IconButton } from './IconButton';
import { CloseIcon, PlusIcon } from './icons';

interface CanvasTabStripProps {
  tabs: CanvasTab[];
  active: string | undefined;
  /** Tab keys with unsaved edits; shown as a dot in place of the close cross. */
  dirty: Record<string, boolean>;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  /** The "+" menu picked a kind of canvas to open. */
  onAdd: (kind: CanvasTabKind) => void;
  onCloseAll: () => void;
}

/** What the "+" menu offers. Browser and code views are meant to join. */
const CANVAS_KINDS: Array<{ kind: CanvasTabKind; label: string }> = [
  { kind: 'markdown', label: 'Markdown file…' },
];

const fileName = (path: string): string => path.split('/').pop() ?? path;

/** The header of the canvas column: one tab per open document, a "+" for
 *  more, and a cross that closes the whole column. */
export function CanvasTabStrip(props: CanvasTabStripProps) {
  const [menuOpen, setMenuOpen] = createSignal(false);

  return (
    <div
      style={{
        height: '34px',
        display: 'flex',
        'align-items': 'stretch',
        gap: '2px',
        padding: '0 4px',
        'border-bottom': `1px solid ${theme.border}`,
      }}
    >
      <div
        role="tablist"
        aria-label="Canvas tabs"
        class="canvas-tab-strip"
        style={{ flex: '1', 'min-width': '0', display: 'flex', 'overflow-x': 'auto' }}
      >
        <For each={props.tabs}>
          {(tab) => {
            const key = canvasTabKey(tab);
            const isActive = () => props.active === key;
            return (
              <div
                role="tab"
                tabIndex={0}
                aria-selected={isActive()}
                title={tab.path}
                onClick={() => props.onActivate(key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') props.onActivate(key);
                }}
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '4px',
                  'max-width': '160px',
                  padding: '0 4px 0 8px',
                  'border-bottom': `2px solid ${isActive() ? theme.accent : 'transparent'}`,
                  color: isActive() ? theme.fg : theme.fgMuted,
                  'font-size': sf(12),
                  'font-family': 'var(--font-mono)',
                  cursor: 'pointer',
                  'white-space': 'nowrap',
                }}
              >
                <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
                  {fileName(tab.path)}
                </span>
                <button
                  type="button"
                  aria-label={`Close ${fileName(tab.path)}`}
                  title={props.dirty[key] ? 'Unsaved edits. Close this tab' : 'Close this tab'}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onClose(key);
                  }}
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    'justify-content': 'center',
                    width: '16px',
                    height: '16px',
                    background: 'transparent',
                    border: 'none',
                    'border-radius': 'var(--radius-sm)',
                    color: props.dirty[key] ? theme.accent : 'inherit',
                    cursor: 'pointer',
                    padding: '0',
                    'font-size': sf(12),
                  }}
                >
                  {props.dirty[key] ? '●' : <CloseIcon size={9} />}
                </button>
              </div>
            );
          }}
        </For>
      </div>
      <div style={{ position: 'relative', display: 'flex', 'align-items': 'center', gap: '2px' }}>
        <IconButton
          icon={<PlusIcon size={16} />}
          onClick={() => setMenuOpen((v) => !v)}
          title="Open another canvas"
        />
        <IconButton
          icon={<CloseIcon size={14} />}
          onClick={props.onCloseAll}
          title="Close the canvas"
          size="sm"
        />
        <Show when={menuOpen()}>
          <div
            onClick={() => setMenuOpen(false)}
            style={{ position: 'fixed', inset: '0', 'z-index': '1200' }}
          />
          <div
            role="menu"
            aria-label="Kinds of canvas"
            class="canvas-kind-menu"
            style={{
              position: 'absolute',
              top: '100%',
              right: '0',
              'z-index': '1201',
              'min-width': '160px',
              padding: '4px',
              background: theme.bgElevated,
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-md)',
              'box-shadow': 'var(--shadow-soft)',
            }}
          >
            <For each={CANVAS_KINDS}>
              {(item) => (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    props.onAdd(item.kind);
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    'text-align': 'left',
                    background: 'transparent',
                    border: 'none',
                    'border-radius': 'var(--radius-sm)',
                    padding: '6px 8px',
                    color: theme.fg,
                    'font-size': sf(12),
                    'font-family': 'var(--font-ui)',
                    cursor: 'pointer',
                  }}
                >
                  {item.label}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
