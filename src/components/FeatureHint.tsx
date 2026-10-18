import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  type JSX,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import { topDialog } from '../lib/dialog-stack';
import type { FeatureHintId } from '../lib/feature-hints';
import { createAnchorEffect, placeBelow, type BelowAnchor } from '../lib/floating';
import { sf } from '../lib/fontScale';
import { theme } from '../lib/theme';
import {
  claimFeatureHint,
  dismissFeatureHint,
  featureHintWanted,
  isFeatureHintActive,
  releaseFeatureHint,
} from '../store/onboarding';

const WIDTH = 300;
/** Roughly the card's height, so an anchor near the bottom gets it above instead. */
const HEIGHT = 190;
/**
 * How long a tip waits once it could show. It lets a dialog finish opening and
 * skips a feature that is only passing through, such as a task the user is
 * switching past.
 */
const SETTLE_MS = 600;

interface FeatureHintAction {
  label: string;
  run: () => void;
}

interface FeatureHintProps {
  id: FeatureHintId;
  /** The feature has something to work on now, e.g. the task has changes. */
  when: boolean;
  anchor: () => HTMLElement | undefined;
  title: string;
  children: JSX.Element;
  /** Tries the feature; taking it counts as having seen the tip. */
  actions?: FeatureHintAction[];
}

function onScreen(rect: DOMRect): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

/** The top dialog's panel; dialogs portal to the body in the order they open. */
function topDialogPanel(): Element | undefined {
  const panels = document.querySelectorAll('.dialog-panel');
  return panels[panels.length - 1];
}

/**
 * A one-time tip floating next to the control it explains. It overlays the
 * page instead of joining its layout, so showing or dismissing it never moves
 * content. Only one tip shows at a time, and only while its anchor is on
 * screen and not covered by a dialog.
 */
export function FeatureHint(props: FeatureHintProps) {
  // Identifies this instance in the single tip slot; several may share an id.
  const owner = Symbol('feature-hint');
  const titleId = createUniqueId();
  const [position, setPosition] = createSignal<BelowAnchor | null>(null);
  const wanted = () => props.when && featureHintWanted(props.id);
  const panel = () => props.anchor()?.closest('.dialog-panel') ?? undefined;
  /** A dialog above the anchor would cover the tip, or the tip would float over it. */
  const uncovered = () => {
    const top = topDialog();
    const own = panel();
    return own ? own === topDialogPanel() : top === null;
  };

  const place = () => {
    const rect = props.anchor()?.getBoundingClientRect();
    setPosition(
      rect && onScreen(rect)
        ? placeBelow(
            rect,
            Math.min(WIDTH, window.innerWidth - 24),
            { width: window.innerWidth, height: window.innerHeight },
            12,
            HEIGHT,
          )
        : null,
    );
  };
  createAnchorEffect(wanted, place);
  // Panels resize and collapse without scrolling the window.
  createEffect(() => {
    const el = props.anchor();
    if (!wanted() || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  });

  // A memo, so moving with a scroll does not restart the settle delay.
  const eligible = createMemo(() => wanted() && uncovered() && position() !== null);
  const [settled, setSettled] = createSignal(false);
  createEffect(() => {
    setSettled(false);
    if (!eligible()) return;
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    onCleanup(() => clearTimeout(timer));
  });
  createEffect(() => {
    if (eligible() && settled()) claimFeatureHint(owner);
    else releaseFeatureHint(owner);
  });
  onCleanup(() => releaseFeatureHint(owner));

  const shown = () => eligible() && isFeatureHintActive(owner);
  const dismiss = () => dismissFeatureHint(props.id, owner);

  return (
    <Show when={shown() ? position() : undefined}>
      {(pos) => (
        <Portal
          mount={panel() ?? document.body}
          // The wrapper must not become a flex item of a dialog panel.
          ref={(el) => (el.style.display = 'contents')}
        >
          <div
            role="note"
            aria-labelledby={titleId}
            class="feature-hint"
            // Escape hides the tip first; a dialog around it closes on the next
            // press. A native listener, since a delegated one runs only after
            // the dialog's own listener on the document.
            ref={(el) =>
              el.addEventListener('keydown', (event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                dismiss();
              })
            }
            style={{
              position: 'fixed',
              top: `${pos().top}px`,
              right: `${pos().right}px`,
              width: `${WIDTH}px`,
              'max-width': 'calc(100vw - 24px)',
              'max-height': `${pos().maxHeight}px`,
              'box-sizing': 'border-box',
              overflow: 'auto',
              // Under dialogs and menus, which cover it when they open.
              'z-index': '900',
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
            <span
              style={{
                display: 'block',
                color: theme.fgSubtle,
                'font-size': sf(11),
                'text-transform': 'uppercase',
                'letter-spacing': '0.05em',
              }}
            >
              Tip
            </span>
            <strong id={titleId} style={{ display: 'block', 'font-size': sf(13) }}>
              {props.title}
            </strong>
            <div style={{ margin: '6px 0 10px', color: theme.fgMuted }}>{props.children}</div>
            <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
              <For each={props.actions}>
                {(action) => (
                  <button
                    type="button"
                    class="btn-secondary"
                    style={buttonStyle(true)}
                    onClick={() => {
                      dismiss();
                      action.run();
                    }}
                  >
                    {action.label}
                  </button>
                )}
              </For>
              <button
                type="button"
                class="btn-secondary"
                style={buttonStyle(!props.actions?.length)}
                onClick={dismiss}
              >
                Got it
              </button>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  );
}

/** Neutral buttons; the main one is marked by full-strength text, not colour. */
function buttonStyle(main: boolean): JSX.CSSProperties {
  return {
    padding: '4px 10px',
    background: theme.bgInput,
    border: `1px solid ${theme.border}`,
    'border-radius': 'var(--radius-sm)',
    color: main ? theme.fg : theme.fgMuted,
    cursor: 'pointer',
    'font-size': sf(12),
  };
}
