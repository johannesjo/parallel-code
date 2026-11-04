import { Show, createSignal, createUniqueId, createEffect, onCleanup, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { ChangeTourController } from '../lib/create-change-tour';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import {
  createAnchorEffect,
  createHeldSignal,
  placeBelow,
  type BelowAnchor,
} from '../lib/floating';
import { store } from '../store/store';
import { activeFeatureHint } from '../store/onboarding';
import { ArrowRightThinIcon, CloseIcon, TourIcon } from './icons';
import { askCodeLabel } from './understanding/ask-code-label';
import { TourModelMenu } from './understanding/TourModelMenu';

/** Hover help waits this long, so a pointer passing over the button does not flash it. */
const HELP_HOVER_DELAY_MS = 500;

export function ChangeTourButton(props: {
  tour: ChangeTourController;
  onClick: () => void;
  disabled?: boolean;
  /** The ready tour explains code that has changed since. */
  outdated?: boolean;
  /** Extra actions shown as segments between the tour action and the model menu. */
  children?: JSX.Element;
}) {
  const ready = () => props.tour.stops().length > 0;
  /** A reader who closed the tour midway picks it up where they left. */
  const resumeLabel = () => {
    const verb = props.tour.step() > 0 ? 'Resume tour' : 'Start tour';
    // The stop count gives way, so the one-line label in Finish keeps "out of date" in view.
    if (props.outdated) return `${verb} · out of date`;
    return props.tour.step() > 0
      ? `${verb} · ${props.tour.step() + 1}/${props.tour.stops().length}`
      : verb;
  };
  const helpId = createUniqueId();
  const help = createHeldSignal<boolean>(150);
  // A first-use tip about the tour already explains it in the same spot.
  const helpOpen = () =>
    !!help.value() &&
    !props.disabled &&
    !props.tour.loading() &&
    !ready() &&
    activeFeatureHint() !== 'change-tour';
  const [position, setPosition] = createSignal<BelowAnchor>({ top: 0, right: 0, maxHeight: 240 });
  let controls: HTMLDivElement | undefined;
  let popover: HTMLDivElement | undefined;
  const openHelp = () => help.set(true);
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelHover = () => {
    clearTimeout(hoverTimer);
    hoverTimer = undefined;
  };
  onCleanup(cancelHover);
  // Focus opens the help at once; a pointer has to rest on the button first.
  const hoverHelp = () => {
    help.hold();
    if (help.value() || hoverTimer) return;
    hoverTimer = setTimeout(() => {
      hoverTimer = undefined;
      openHelp();
    }, HELP_HOVER_DELAY_MS);
  };
  const closeHelp = () => {
    cancelHover();
    help.set(false);
  };
  createAnchorEffect(helpOpen, () => {
    if (controls)
      setPosition(
        placeBelow(
          controls.getBoundingClientRect(),
          Math.min(320, window.innerWidth - 24),
          { width: window.innerWidth, height: window.innerHeight },
          12,
          260,
        ),
      );
  });
  createEffect(() => {
    if (!helpOpen()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeHelp();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !controls?.contains(event.target) &&
        !popover?.contains(event.target)
      )
        closeHelp();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    onCleanup(() => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    });
  });
  let action: HTMLButtonElement | undefined;
  return (
    <Show when={!props.disabled || props.tour.loading() || ready()}>
      <div class="change-tour-footer">
        {/* The chevron picks the model this tour and every code question use. It
            stays outside the hover anchor, so reaching for it does not raise the
            help popover over the menu it is about to open. */}
        <div class="change-tour-row">
          <div
            class="change-tour-hover"
            ref={controls}
            onMouseEnter={hoverHelp}
            onMouseLeave={() => {
              cancelHover();
              if (!controls?.contains(document.activeElement)) help.clear();
            }}
            onFocusIn={openHelp}
            onFocusOut={(event) => {
              if (
                !(event.relatedTarget instanceof Node) ||
                !controls?.contains(event.relatedTarget)
              )
                closeHelp();
            }}
          >
            <button
              ref={action}
              class="change-tour-action"
              disabled={props.disabled && !props.tour.loading() && !ready()}
              // Shows the run while it lasts; the × beside it is what stops it.
              aria-busy={props.tour.loading()}
              aria-describedby={helpOpen() ? helpId : undefined}
              title={
                props.tour.loading()
                  ? undefined
                  : props.tour.error() ||
                    (ready()
                      ? (props.tour.step() > 0
                          ? `Resume guided tour at stop ${props.tour.step() + 1} of ${props.tour.stops().length}`
                          : 'Start guided tour') +
                        (props.outdated
                          ? '. Made before the latest changes; regenerate to cover them.'
                          : '')
                      : undefined)
              }
              onClick={(event) => {
                event.stopPropagation();
                closeHelp();
                if (!props.tour.loading()) props.onClick();
              }}
            >
              <Show
                when={props.tour.loading()}
                fallback={
                  <Show when={ready()} fallback={<TourIcon size={14} />}>
                    <span
                      aria-label="Tour ready"
                      style={{
                        color: props.outdated ? theme.fgMuted : theme.success,
                        width: '14px',
                        'flex-shrink': '0',
                        'text-align': 'center',
                      }}
                    >
                      ✓
                    </span>
                  </Show>
                }
              >
                <span class="inline-spinner" aria-hidden="true" />
              </Show>
              <span class="change-tour-action-label">
                {props.tour.loading()
                  ? props.tour.progress()
                  : ready()
                    ? resumeLabel()
                    : props.tour.error()
                      ? 'Retry tour'
                      : 'Generate tour'}
                <Show when={props.tour.loading()}>
                  <span style={{ display: 'block', color: theme.fgMuted, 'font-size': sf(11) }}>
                    {props.tour.progress() === 'Reading changes…'
                      ? 'Preparing tour'
                      : props.tour.receiving()
                        ? 'Receiving response'
                        : 'Waiting for provider'}{' '}
                    · {props.tour.elapsedSeconds()}s
                  </span>
                </Show>
              </span>
              {/* Hidden, not removed, so the label keeps its width while the tour generates. */}
              <ArrowRightThinIcon
                size={14}
                class="change-tour-arrow"
                style={{ visibility: props.tour.loading() ? 'hidden' : undefined }}
              />
            </button>
          </div>
          {props.children}
          {/* A generating tour keeps the model it started with, so the × to cancel takes the menu's place. */}
          <Show when={props.tour.loading()} fallback={<TourModelMenu class="change-tour-model" />}>
            <button
              type="button"
              class="change-tour-model"
              aria-label="Cancel tour generation"
              title="Cancel tour generation"
              onClick={(event) => {
                event.stopPropagation();
                // The × goes away with the run; keep focus on the tour, not the page.
                action?.focus();
                // That focus is not the user's: it must not raise the help popover.
                closeHelp();
                props.tour.cancel();
              }}
            >
              <CloseIcon size={12} />
            </button>
          </Show>
        </div>
        <Show when={helpOpen()}>
          <Portal>
            <div
              ref={popover}
              id={helpId}
              role="tooltip"
              onMouseEnter={help.hold}
              onMouseLeave={help.clear}
              style={{
                position: 'fixed',
                top: `${position().top}px`,
                right: `${position().right}px`,
                width: '320px',
                'max-width': 'calc(100vw - 24px)',
                'max-height': `${Math.min(260, position().maxHeight)}px`,
                'box-sizing': 'border-box',
                overflow: 'auto',
                'z-index': 'var(--z-overlay)',
                padding: '14px',
                background: theme.bgElevated,
                color: theme.fg,
                border: `1px solid ${theme.border}`,
                'border-radius': 'var(--radius-sm)',
                'box-shadow': '0 4px 16px rgba(0, 0, 0, 0.3)',
                'font-size': sf(13),
                'line-height': '1.5',
              }}
            >
              <strong>Tour of changes</strong>
              <p style={{ margin: '8px 0' }}>
                Creates a short walkthrough linked to your changed code. Generates in the
                background; click Start tour when ready.
              </p>
              <p style={{ margin: '8px 0' }}>
                <strong>Uses: </strong>
                {askCodeLabel(store.askCodeProvider, store.askCodeModel)}
                {store.askCodeProvider === 'claude' ? ' (CLI model alias)' : ''}
              </p>
              <p style={{ margin: '8px 0 0', color: theme.fgMuted }}>
                Sends the selected tour diff to this provider. Does not modify files or verify
                correctness.
              </p>
            </div>
          </Portal>
        </Show>
        <Show when={props.tour.error()}>
          <p
            role="alert"
            class="change-tour-error"
            style={{
              color: theme.error,
              margin: '0',
              padding: '6px 10px',
              'overflow-wrap': 'anywhere',
            }}
          >
            {props.tour.error()}
          </p>
        </Show>
      </div>
    </Show>
  );
}
