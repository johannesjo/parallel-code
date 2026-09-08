import { For, Show, type JSX } from 'solid-js';
import { theme } from '../lib/theme';
import { BookmarkIcon } from './icons';

/** Minimal bookmark shape the gutter needs to draw. Position is supplied
 *  separately via `topOf` so it can track live xterm state without re-creating
 *  the DOM node (the bookmark objects themselves stay referentially stable). */
export interface TerminalBookmarkInfo {
  id: number;
  preview: string;
}

export interface TerminalBookmarkGutterProps {
  /** Reserved strip width in px — the terminal is inset by this much so icons never overlap it. */
  width: number;
  bookmarks: readonly TerminalBookmarkInfo[];
  /** Top px for a bookmark icon, or null when it's folded into an overflow badge. */
  topOf: (id: number) => number | null;
  onJump: (id: number) => void;
  onRemove: (id: number) => void;
  /** Count + position of bookmarks scrolled off the top, beyond the fan cap. */
  aboveCount: number;
  aboveTop: number;
  onJumpAbove: () => void;
  /** Count + position of bookmarks scrolled off the bottom, beyond the fan cap. */
  belowCount: number;
  belowTop: number;
  onJumpBelow: () => void;
  /** Whether the "bookmark selection" button is shown (i.e. there is an active selection). */
  createVisible: boolean;
  /** Vertical position of the create button, in px from the top of the gutter. */
  createTop: number;
  onCreate: () => void;
}

/** Left-edge gutter for one terminal pane. Purely presentational — the owning
 *  TerminalView registers xterm markers and feeds positions back in. A bookmark
 *  icon sits next to its line and scrolls with the content; off-screen ones fan
 *  at the nearest edge, with a "+N" badge once the fan is full. */
export function TerminalBookmarkGutter(props: TerminalBookmarkGutterProps): JSX.Element {
  return (
    // pointer-events:none on the strip itself so the empty gutter never eats
    // clicks; each interactive child re-enables them.
    <div
      style={{
        position: 'absolute',
        left: '0',
        top: '0',
        bottom: '0',
        width: `${props.width}px`,
        'z-index': '5',
        'pointer-events': 'none',
      }}
    >
      <For each={props.bookmarks}>
        {(b) => (
          <Show when={props.topOf(b.id) !== null}>
            <button
              type="button"
              title={`${b.preview}\n\nClick to jump · Right-click to remove`}
              aria-label={`Jump to bookmark: ${b.preview}`}
              onClick={(e) => {
                e.stopPropagation();
                props.onJump(b.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                props.onRemove(b.id);
              }}
              style={{
                position: 'absolute',
                left: '50%',
                top: `${props.topOf(b.id)}px`,
                transform: 'translate(-50%, -50%)',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                width: '20px',
                height: '20px',
                padding: '0',
                background: 'transparent',
                border: 'none',
                color: theme.accent,
                cursor: 'pointer',
                'pointer-events': 'auto',
                // Lift the glyph off the terminal background for legibility.
                filter: 'drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.55))',
              }}
            >
              <BookmarkIcon size={15} />
            </button>
          </Show>
        )}
      </For>
      <Show when={props.aboveCount > 0}>
        <OverflowBadge
          count={props.aboveCount}
          top={props.aboveTop}
          direction="above"
          onClick={props.onJumpAbove}
        />
      </Show>
      <Show when={props.belowCount > 0}>
        <OverflowBadge
          count={props.belowCount}
          top={props.belowTop}
          direction="below"
          onClick={props.onJumpBelow}
        />
      </Show>
      <Show when={props.createVisible}>
        <button
          type="button"
          title="Bookmark selection"
          aria-label="Bookmark selection"
          // Don't steal focus from the terminal selection when pressed.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            props.onCreate();
          }}
          style={{
            position: 'absolute',
            left: '50%',
            top: `${props.createTop}px`,
            transform: 'translateX(-50%)',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            width: '22px',
            height: '22px',
            padding: '0',
            'border-radius': 'var(--radius-sm)',
            background: theme.bgElevated,
            border: `1px solid ${theme.border}`,
            color: theme.fgMuted,
            cursor: 'pointer',
            'box-shadow': '0 1px 4px rgba(0, 0, 0, 0.4)',
            'pointer-events': 'auto',
          }}
        >
          <BookmarkIcon size={14} />
        </button>
      </Show>
    </div>
  );
}

/** "+N" pill for bookmarks scrolled past the fan cap; jumps to the nearest one. */
function OverflowBadge(props: {
  count: number;
  top: number;
  direction: 'above' | 'below';
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      title={`${props.count} more bookmark${props.count === 1 ? '' : 's'} ${props.direction} — click to jump`}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      style={{
        position: 'absolute',
        left: '50%',
        top: `${props.top}px`,
        transform: 'translate(-50%, -50%)',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        height: '12px',
        padding: '0 3px',
        'border-radius': 'var(--radius-sm)',
        background: theme.bgElevated,
        border: `1px solid ${theme.border}`,
        color: theme.accent,
        'font-family': 'var(--font-ui)',
        'font-size': '11px',
        'font-weight': '600',
        'line-height': '1',
        cursor: 'pointer',
        'pointer-events': 'auto',
      }}
    >
      +{props.count}
    </button>
  );
}
