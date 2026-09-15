import { Show, createSignal, createUniqueId, createEffect, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { ChangeTourController } from '../lib/create-change-tour';
import type { ChangeTourScope } from '../lib/change-tour';
import { theme } from '../lib/theme';
import { CheckIcon } from '../components/icons';
import { sf } from '../lib/fontScale';
import {
  createAnchorEffect,
  createHeldSignal,
  placeBelow,
  type BelowAnchor,
} from '../lib/floating';
import { store } from '../store/store';
import { ASK_CODE_MODELS } from '../../electron/shared/ask-code-models';

export function ChangeTourButton(props: {
  tour: ChangeTourController;
  onClick: () => void;
  disabled?: boolean;
  scope?: ChangeTourScope;
  onScopeChange?: (scope: ChangeTourScope) => void;
}) {
  const ready = () => props.tour.stops().length > 0;
  const helpId = createUniqueId();
  const help = createHeldSignal<boolean>(150);
  const helpOpen = () => !!help.value() && !props.disabled && !props.tour.loading() && !ready();
  const [position, setPosition] = createSignal<BelowAnchor>({ top: 0, right: 0, maxHeight: 240 });
  let controls: HTMLDivElement | undefined;
  let popover: HTMLDivElement | undefined;
  const openHelp = () => help.set(true);
  const closeHelp = () => help.set(false);
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
  return (
    <Show when={!props.disabled || props.tour.loading() || ready() || props.scope === 'selection'}>
      <div
        style={{
          padding: '6px 8px',
          'border-top': `1px solid ${theme.border}`,
          'flex-shrink': '0',
          'font-size': sf(12),
        }}
      >
        <div
          ref={controls}
          onMouseEnter={openHelp}
          onMouseLeave={() => {
            if (!controls?.contains(document.activeElement)) help.clear();
          }}
          onFocusIn={openHelp}
          onFocusOut={(event) => {
            if (!(event.relatedTarget instanceof Node) || !controls?.contains(event.relatedTarget))
              closeHelp();
          }}
          style={{
            display: 'flex',
            'justify-content': 'flex-end',
            'align-items': 'center',
            gap: '6px',
            'flex-wrap': 'wrap',
          }}
        >
          <Show when={props.onScopeChange}>
            <select
              class="review-control"
              aria-label="Tour scope"
              title="Automatic: whole branch including uncommitted work; main, master and develop use uncommitted changes only. Current diff uses the commit selector."
              value={props.scope ?? 'auto'}
              disabled={props.tour.loading()}
              onChange={(event) =>
                props.onScopeChange?.(
                  event.currentTarget.value === 'selection' ? 'selection' : 'auto',
                )
              }
            >
              <option value="auto">Automatic</option>
              <option value="selection">Current diff</option>
            </select>
          </Show>
          <button
            class="review-control"
            disabled={props.disabled && !props.tour.loading() && !ready()}
            aria-busy={props.tour.loading()}
            aria-describedby={helpOpen() ? helpId : undefined}
            title={
              props.tour.loading()
                ? 'Cancel tour generation'
                : props.tour.error() || (ready() ? 'Start guided tour' : undefined)
            }
            onClick={(event) => {
              event.stopPropagation();
              closeHelp();
              if (props.tour.loading()) props.tour.cancel();
              else props.onClick();
            }}
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '6px',
              'max-width': '100%',
              'text-align': 'left',
            }}
          >
            <Show when={props.tour.loading()}>
              <span class="inline-spinner" aria-hidden="true" />
            </Show>
            <Show when={!props.tour.loading() && ready()}>
              <span aria-label="Tour ready" style={{ color: theme.success }}>
                <CheckIcon size={12} />
              </span>
            </Show>
            <span>
              {props.tour.loading()
                ? props.tour.progress()
                : ready()
                  ? 'Start tour'
                  : props.tour.error()
                    ? 'Retry tour'
                    : 'Generate tour of changes'}
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
          </button>
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
                'z-index': '2000',
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
                {store.askCodeProvider === 'minimax'
                  ? `MiniMax · ${ASK_CODE_MODELS.minimax}`
                  : `Claude Code · ${ASK_CODE_MODELS.claude} (CLI model alias)`}
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
            style={{ color: theme.error, margin: '6px 0 0', 'overflow-wrap': 'anywhere' }}
          >
            {props.tour.error()}
          </p>
        </Show>
      </div>
    </Show>
  );
}
