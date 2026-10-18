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
import { placeHint, type HintPlacement } from '../lib/feature-hint-placement';
import type { FeatureHintId } from '../lib/feature-hints';
import { createAnchorEffect } from '../lib/floating';
import { sf } from '../lib/fontScale';
import { theme } from '../lib/theme';
import {
  claimFeatureHint,
  featureHintWanted,
  isFeatureHintActive,
  markFeatureHintSeen,
  releaseFeatureHint,
} from '../store/onboarding';

const WIDTH = 300;
/** The card's height until it renders and can be measured. */
const ESTIMATED_HEIGHT = 190;
/**
 * How long a tip waits once it could show. It lets a dialog finish opening and
 * skips a feature that is only passing through, such as a task the user is
 * switching past.
 */
const SETTLE_MS = 600;
const CARET = 10;

interface FeatureHintAction {
  label: string;
  run: () => void;
  /** Muted, for an action that leaves what the user is doing, e.g. a dialog. */
  quiet?: boolean;
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

interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The part of `el` the user can see: its box cut by every ancestor that clips
 * its overflow, and by the window. Undefined when nothing of it shows.
 */
function visibleBox(el: HTMLElement): Box | undefined {
  const rect = el.getBoundingClientRect();
  const box = { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
  const clip = (by: Box) => {
    box.top = Math.max(box.top, by.top);
    box.right = Math.min(box.right, by.right);
    box.bottom = Math.min(box.bottom, by.bottom);
    box.left = Math.max(box.left, by.left);
  };
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible')
      clip(parent.getBoundingClientRect());
  }
  clip({ top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 });
  return box.right > box.left && box.bottom > box.top ? box : undefined;
}

function samePlacement(a: HintPlacement | null, b: HintPlacement | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A one-time tip floating next to the control it explains. It overlays the
 * page instead of joining its layout, so showing or dismissing it never moves
 * content. Only one tip shows at a time, and only while its anchor is in view
 * and not covered by a dialog.
 */
export function FeatureHint(props: FeatureHintProps) {
  // Identifies this instance in the single tip slot; several may share an id.
  const owner = Symbol('feature-hint');
  const titleId = createUniqueId();
  let card: HTMLDivElement | undefined;
  const [position, setPosition] = createSignal<HintPlacement | null>(null, {
    equals: samePlacement,
  });
  const wanted = () => props.when && featureHintWanted(props.id);
  const panel = () => props.anchor()?.closest<HTMLElement>('.dialog-panel') ?? undefined;
  /** A dialog above the anchor would cover the tip, or the tip would float over it. */
  const uncovered = () => {
    const top = topDialog();
    const own = panel();
    return own ? own.dataset.dialogId === top : top === null;
  };

  const place = () => {
    const anchor = props.anchor();
    const box = anchor && visibleBox(anchor);
    if (!box) return setPosition(null);
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const placed = placeHint(
      box,
      viewport,
      Math.min(WIDTH, viewport.width - 24),
      card?.offsetHeight || ESTIMATED_HEIGHT,
      panel()?.getBoundingClientRect(),
    );
    // A dialog's backdrop filter makes its overlay the box that fixed
    // positions count from; it spans the window unless the dialog insets it.
    const overlay = panel()?.closest('.dialog-overlay')?.getBoundingClientRect();
    setPosition(
      overlay
        ? {
            ...placed,
            left: placed.left - overlay.left,
            top: placed.top === undefined ? undefined : placed.top - overlay.top,
            bottom:
              placed.bottom === undefined
                ? undefined
                : placed.bottom - (viewport.height - overlay.bottom),
          }
        : placed,
    );
  };

  // Scrolls fire many times a frame, terminals' included; measure once per frame.
  let pending = 0;
  const schedule = () => {
    if (!pending)
      pending = requestAnimationFrame(() => {
        pending = 0;
        place();
      });
  };
  onCleanup(() => cancelAnimationFrame(pending));

  // Until the tip shows, it only needs to learn when its anchor comes into view.
  const watching = () => wanted() && uncovered();
  createAnchorEffect(watching, schedule);
  createEffect(() => {
    const el = props.anchor();
    if (!watching() || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  });

  // A memo, so moving with a scroll does not restart the settle delay.
  const eligible = createMemo(() => watching() && position() !== null);
  const [settled, setSettled] = createSignal(false);
  createEffect(() => {
    setSettled(false);
    if (!eligible()) return;
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    onCleanup(() => clearTimeout(timer));
  });
  createEffect(() => {
    if (eligible() && settled()) claimFeatureHint(owner, props.id);
    else releaseFeatureHint(owner);
  });
  onCleanup(() => releaseFeatureHint(owner));

  const shown = () => eligible() && isFeatureHintActive(owner);
  // Anchors also move without a scroll or a resize of their own: a panel
  // opening with an animation, a split being dragged, a neighbour closing.
  createEffect(() => {
    if (!shown()) return;
    let frame = requestAnimationFrame(function follow() {
      place();
      frame = requestAnimationFrame(follow);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  const dismiss = () => markFeatureHintSeen(props.id);

  return (
    <Show when={shown() ? position() : undefined}>
      {(pos) => (
        <Portal
          mount={panel() ?? document.body}
          // The wrapper must not become a flex item of a dialog panel.
          ref={(el) => (el.style.display = 'contents')}
        >
          <div
            ref={(el) => {
              card = el;
              // Escape while the tip has focus hides it, not the dialog around
              // it. A native listener, since a delegated one runs only after
              // the dialog's own listener on the document.
              el.addEventListener('keydown', (event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                dismiss();
              });
            }}
            role="note"
            aria-labelledby={titleId}
            class="feature-hint"
            // Clicking the tip leaves focus where the user was typing.
            onMouseDown={(event) => {
              if (event.target instanceof HTMLButtonElement) event.preventDefault();
            }}
            style={{
              position: 'fixed',
              left: `${pos().left}px`,
              top: pos().top === undefined ? undefined : `${pos().top}px`,
              bottom: pos().bottom === undefined ? undefined : `${pos().bottom}px`,
              width: `${WIDTH}px`,
              'max-width': 'calc(100vw - 24px)',
              'box-sizing': 'border-box',
              // Under dialogs and menus, which cover it when they open.
              'z-index': '900',
              color: theme.fg,
              background: theme.bgElevated,
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-sm)',
              'box-shadow': '0 4px 16px rgba(0, 0, 0, 0.3)',
              'font-size': sf(12),
              'line-height': '1.5',
            }}
          >
            <span aria-hidden="true" style={caretStyle(pos().caret)} />
            {/* Scrolls inside, so the caret outside the edge is not clipped. */}
            <div
              style={{
                'max-height': `${pos().maxHeight}px`,
                'box-sizing': 'border-box',
                overflow: 'auto',
                padding: '12px 14px',
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
                      style={buttonStyle(!action.quiet)}
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
                  style={buttonStyle(!props.actions?.some((action) => !action.quiet))}
                  onClick={dismiss}
                >
                  Got it
                </button>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  );
}

/** A square turned 45° over the card's edge, bordered on its two outer sides. */
function caretStyle(caret: HintPlacement['caret']): JSX.CSSProperties {
  const line = `1px solid ${theme.border}`;
  const along = `${caret.offset - CARET / 2}px`;
  const out = `${-CARET / 2 - 1}px`;
  const vertical = caret.side === 'top' || caret.side === 'bottom';
  return {
    position: 'absolute',
    width: `${CARET}px`,
    height: `${CARET}px`,
    background: theme.bgElevated,
    transform: 'rotate(45deg)',
    [caret.side]: out,
    [vertical ? 'left' : 'top']: along,
    'border-top': caret.side === 'top' || caret.side === 'right' ? line : undefined,
    'border-left': caret.side === 'top' || caret.side === 'left' ? line : undefined,
    'border-bottom': caret.side === 'bottom' || caret.side === 'left' ? line : undefined,
    'border-right': caret.side === 'bottom' || caret.side === 'right' ? line : undefined,
  };
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
