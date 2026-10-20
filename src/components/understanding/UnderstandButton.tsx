import { Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { theme } from '../../lib/theme';
import { sf } from '../../lib/fontScale';
import type { UnderstandingTourController } from '../../lib/create-understanding-tour';
import type { UnderstandingTourKind } from '../../lib/understanding-tour';
import { TourHint } from './TourHint';
import { TourModelMenu } from './TourModelMenu';

/**
 * Chrome shared by Take Tour and the Review Plan button it sits beside, so the
 * pair matches exactly. Opaque, so a long note runs behind it, not through it.
 */
export const tourButtonStyle: JSX.CSSProperties = {
  padding: '4px 10px',
  'font-size': sf(11),
  'font-family': "'JetBrains Mono', monospace",
  'line-height': '1',
  background: `color-mix(in srgb, ${theme.accent} 12%, ${theme.bgInput})`,
  color: theme.fg,
  border: `1px solid color-mix(in srgb, ${theme.accent} 25%, ${theme.border})`,
  'border-radius': 'var(--radius-sm)',
  cursor: 'pointer',
};

/**
 * Entry-point button for an understanding tour. Generation runs in the
 * background, so the states are: idle starts it, generating cancels, ready
 * opens, error retries. A hover popover names the subject and the next action.
 * Pass `class` to replace the default chrome entirely.
 */
export function UnderstandButton(props: {
  label: string;
  tour: UnderstandingTourController;
  /** Which tour this button starts; the controller is shared between buttons. */
  kind: UnderstandingTourKind;
  subject: string;
  onClick: () => void;
  disabled?: boolean;
  class?: string;
  style?: JSX.CSSProperties;
  /** Glues a chevron to the right that picks the provider and model. */
  modelMenu?: boolean;
}) {
  const ready = () => props.tour.isReady(props.kind, props.subject);
  const loading = () => props.tour.isLoading(props.kind, props.subject);
  const error = () => props.tour.errorFor(props.kind, props.subject);
  /** The pair reads as one control: only their outer corners are rounded. The
   *  flat footer chrome has no radius to flatten, so it needs no override. */
  const mainStyle = (): JSX.CSSProperties =>
    props.modelMenu && props.style
      ? { ...props.style, 'border-top-right-radius': '0px', 'border-bottom-right-radius': '0px' }
      : (props.style ?? {});
  const triggerStyle = (): JSX.CSSProperties => ({
    ...props.style,
    'border-top-left-radius': '0px',
    'border-bottom-left-radius': '0px',
    'border-left': 'none',
    padding: '4px 5px',
    // The chevron is an inline svg; centring it keeps both halves the same height.
    display: 'inline-flex',
    'align-items': 'center',
  });

  const main = (
    <TourHint kind={props.kind} subject={props.subject} tour={props.tour}>
      {(describedBy) => (
        <button
          type="button"
          class={props.class ?? 'change-tour-action understanding-action'}
          style={mainStyle()}
          disabled={props.disabled && !loading() && !ready()}
          aria-busy={loading()}
          aria-describedby={describedBy()}
          onClick={(event) => {
            event.stopPropagation();
            if (loading()) props.tour.cancel();
            else props.onClick();
          }}
        >
          <Show when={loading()}>
            <span
              class="inline-spinner"
              aria-hidden="true"
              style={{ 'vertical-align': 'middle' }}
            />{' '}
          </Show>
          <Show when={!loading() && ready()}>
            <span aria-label="Tour ready" style={{ color: theme.success }}>
              ✓
            </span>{' '}
          </Show>
          <span class={props.class ? undefined : 'change-tour-action-label'}>
            {!loading() && !ready() && error() ? 'Retry' : props.label}
          </span>
        </button>
      )}
    </TourHint>
  );

  return (
    <Show when={props.modelMenu} fallback={main}>
      <span class="tour-split" style={{ display: 'inline-flex' }}>
        {main}
        {/* Default chrome is the flat footer bar, whose chevron carries its own
            divider; a caller-supplied pill class needs the glued-corner overrides. */}
        <TourModelMenu
          class={props.class ?? 'change-tour-model'}
          style={props.style ? triggerStyle() : undefined}
        />
      </span>
    </Show>
  );
}
