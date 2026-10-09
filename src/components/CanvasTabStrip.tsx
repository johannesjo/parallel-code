import { For, Show, createSignal } from 'solid-js';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { canvasTabKey } from '../lib/canvas-tabs';
import type { CanvasTab, CanvasTabKind } from '../store/types';
import { IconButton } from './IconButton';
import { CloseIcon, ExpandIcon, ExternalLinkIcon, PlusIcon, ScreenNormalIcon } from './icons';
import { UnderstandButton, tourButtonStyle } from './understanding/UnderstandButton';
import type { UnderstandingTourController } from '../lib/create-understanding-tour';

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
  fullscreen: boolean;
  onEnterFullscreen: () => void;
  onExitFullscreen: () => void;
  /** Hands the open document to whatever the system opens Markdown with. */
  onOpenInDefaultEditor: (path: string) => void;
  /** Both present: the open document gets a Take Tour button. */
  understanding?: UnderstandingTourController;
  onTakeTour?: (path: string) => void;
  /** Which tour the open document gets: the task's plan or any other document. */
  tourKind?: (path: string) => 'plan' | 'document';
}

/** What the "+" menu offers. */
const CANVAS_KINDS: Array<{ kind: CanvasTabKind; label: string }> = [
  { kind: 'markdown', label: 'Markdown file…' },
  { kind: 'browser', label: 'Browser' },
  { kind: 'mindmap', label: 'Mind map' },
  { kind: 'reasoning', label: 'Reasoning' },
];

/** An open canvas is shown again rather than opened twice; say so in the menu. */
const menuLabel = (tabs: CanvasTab[], item: { kind: CanvasTabKind; label: string }): string =>
  item.kind !== 'markdown' && tabs.some((tab) => tab.kind === item.kind)
    ? `Show ${item.label.toLowerCase()}`
    : item.label;

const tabLabel = (tab: CanvasTab): string => {
  if (tab.kind === 'markdown') return tab.path.split('/').pop() ?? tab.path;
  return CANVAS_KINDS.find((kind) => kind.kind === tab.kind)?.label ?? tab.kind;
};

/** The header of the canvas column: one tab per open document, a "+" for
 *  more, and a cross that closes the whole column. */
export function CanvasTabStrip(props: CanvasTabStripProps) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  /** The file behind the open tab, when the open tab is a document. */
  const activePath = (): string | undefined => {
    const tab = props.tabs.find((candidate) => canvasTabKey(candidate) === props.active);
    return tab?.kind === 'markdown' ? tab.path : undefined;
  };
  const tourTarget = () => {
    const path = activePath();
    const tour = props.understanding;
    const onTakeTour = props.onTakeTour;
    return path && tour && onTakeTour ? { path, tour, onTakeTour } : undefined;
  };

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
                data-canvas-document-path={tab.kind === 'markdown' ? tab.path : undefined}
                tabIndex={0}
                aria-selected={isActive()}
                title={
                  tab.kind === 'markdown'
                    ? tab.path
                    : tab.kind === 'browser'
                      ? 'Browser preview'
                      : tabLabel(tab)
                }
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
                  {tabLabel(tab)}
                </span>
                <button
                  type="button"
                  aria-label={`Close ${tabLabel(tab)}`}
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
        <Show when={props.fullscreen}>
          <button
            class="btn-with-icon"
            type="button"
            onClick={() => props.onExitFullscreen()}
            title="Exit fullscreen"
            style={{
              padding: '3px 7px',
              background: 'transparent',
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-sm)',
              color: theme.fgMuted,
              cursor: 'pointer',
              'font-family': 'var(--font-ui)',
              'font-size': sf(11),
            }}
          >
            <ScreenNormalIcon size={12} />
            Exit fullscreen
          </button>
        </Show>
        <Show when={tourTarget()}>
          {(target) => (
            <UnderstandButton
              label="Take Tour"
              tour={target().tour}
              kind={props.tourKind?.(target().path) ?? 'document'}
              subject={target().path}
              onClick={() => target().onTakeTour(target().path)}
              class="btn-secondary review-plan-btn canvas-tour-btn"
              style={tourButtonStyle}
              modelMenu
            />
          )}
        </Show>
        <Show when={activePath()}>
          {(path) => (
            <IconButton
              icon={<ExternalLinkIcon size={13} />}
              onClick={() => props.onOpenInDefaultEditor(path())}
              title={`Open ${path()} in the default editor`}
            />
          )}
        </Show>
        <Show when={!props.fullscreen && activePath()}>
          <IconButton
            icon={<ExpandIcon size={13} />}
            onClick={() => props.onEnterFullscreen()}
            title="Fill the window with this canvas"
          />
        </Show>
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
                  {menuLabel(props.tabs, item)}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
