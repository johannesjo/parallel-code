import { Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { accentControlColors } from '../lib/controlStyle';
import { CommitTreeView } from './CommitTreeView';
import { CloseIcon, GitGraphIcon } from './icons';
import type { CommitSelection } from './CommitNavBar';
import type { CommitInfo } from '../ipc/types';

interface CommitTreeOverlayProps {
  commits: CommitInfo[];
  worktreePath: string;
  baseBranch?: string;
  selectedCommit: CommitSelection;
  onSelectCommit: (hash: string) => void;
}

const PANEL_WIDTH = 380;

/**
 * A single header button that reveals the commit tree as a floating overlay
 * anchored to the button, rather than swapping the panel body. Closes on Esc,
 * on a click outside, or when a commit is picked.
 */
export function CommitTreeOverlay(props: CommitTreeOverlayProps) {
  const [open, setOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<DOMRect | null>(null);
  let btn: HTMLButtonElement | undefined;

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    if (open()) {
      setOpen(false);
      return;
    }
    if (btn) setAnchor(btn.getBoundingClientRect());
    setOpen(true);
  }

  createEffect(() => {
    if (!open()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    // Keep the panel pinned to the button if an ancestor scrolls or the window
    // resizes while open (the captured rect would otherwise go stale).
    const reposition = () => btn && setAnchor(btn.getBoundingClientRect());
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    onCleanup(() => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    });
  });

  // Anchor below the button by default; flip above when the panel sits low and
  // there is more room overhead. Recomputed from a fresh rect on open and on
  // scroll/resize.
  const panel = createMemo(() => {
    const r = anchor();
    if (!r) return null;
    const left = Math.max(8, Math.min(r.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8));
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const spaceAbove = r.top - 8;
    if (spaceBelow < 220 && spaceAbove > spaceBelow) {
      return {
        left,
        placement: 'up' as const,
        offset: window.innerHeight - r.top + 4,
        maxHeight: Math.max(160, spaceAbove - 4),
      };
    }
    return {
      left,
      placement: 'down' as const,
      offset: r.bottom + 4,
      maxHeight: Math.max(160, spaceBelow),
    };
  });

  return (
    <>
      <button
        ref={(el) => (btn = el)}
        title="Commit tree"
        aria-haspopup="true"
        aria-expanded={open()}
        onClick={toggle}
        style={buttonStyle(open())}
      >
        <GitGraphIcon size={12} />
      </button>

      <Show when={open() ? panel() : null}>
        {(p) => (
          <Portal>
            <div
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              style={{ position: 'fixed', inset: '0', 'z-index': '998' }}
            />
            <div
              role="group"
              aria-label="Commit tree"
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: `${p().left}px`,
                ...(p().placement === 'down'
                  ? { top: `${p().offset}px` }
                  : { bottom: `${p().offset}px` }),
                width: `${PANEL_WIDTH}px`,
                'max-height': `${p().maxHeight}px`,
                'z-index': '999',
                background: theme.taskPanelBg,
                border: `1px solid ${theme.border}`,
                'border-radius': 'var(--radius-md)',
                'box-shadow': '0 8px 28px rgba(0, 0, 0, 0.4)',
                display: 'flex',
                'flex-direction': 'column',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: '6px 10px',
                  'font-size': sf(11),
                  'font-weight': '600',
                  color: theme.fgMuted,
                  'text-transform': 'uppercase',
                  'letter-spacing': '0.05em',
                  'border-bottom': `1px solid ${theme.border}`,
                  'flex-shrink': '0',
                  display: 'flex',
                  'align-items': 'center',
                }}
              >
                <span style={{ flex: '1' }}>Commit Tree</span>
                <button title="Close" onClick={() => setOpen(false)} style={closeStyle()}>
                  <CloseIcon size={12} />
                </button>
              </div>
              <div style={{ flex: '1', 'min-height': '0', display: 'flex' }}>
                <CommitTreeView
                  commits={props.commits}
                  worktreePath={props.worktreePath}
                  baseBranch={props.baseBranch}
                  selectedCommit={props.selectedCommit}
                  onSelectCommit={(hash) => {
                    props.onSelectCommit(hash);
                    setOpen(false);
                  }}
                />
              </div>
            </div>
          </Portal>
        )}
      </Show>
    </>
  );
}

function buttonStyle(active: boolean) {
  return {
    ...accentControlColors(active),
    cursor: 'pointer',
    'border-radius': 'var(--radius-xs)',
    padding: '0',
    width: '18px',
    height: '18px',
    display: 'inline-flex',
    'align-items': 'center',
    'justify-content': 'center',
    'flex-shrink': '0',
  } as const;
}

function closeStyle() {
  return {
    background: 'transparent',
    border: 'none',
    color: theme.fgMuted,
    cursor: 'pointer',
    'font-size': sf(12),
    'line-height': '1',
    padding: '0 2px',
  } as const;
}
