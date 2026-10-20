import type { JSX } from 'solid-js';

/**
 * One 28×28 chrome control of the tour: muted at rest, legible on hover or
 * focus. A glyph alone never says what it does, so every instance names itself
 * twice — `aria-label` for assistive tech and `title` as the pointer tooltip.
 */
export function TourIconButton(props: {
  label: string;
  /** Tooltip text; falls back to the label. */
  tooltip?: string;
  onClick: () => void;
  disabled?: boolean;
  /** The way forward, kept a shade brighter than the controls around it. */
  primary?: boolean;
  /** A toggle's state; pressed shows in the accent, as state rather than urgency. */
  pressed?: boolean;
  /** Extra class, for a control the stylesheet shows only in some layouts. */
  class?: string;
  ref?: (element: HTMLButtonElement) => void;
  children: JSX.Element;
}) {
  return (
    <button
      // Wrapped so an absent ref cannot be written back onto the props object.
      ref={(element) => props.ref?.(element)}
      type="button"
      class={`${props.primary ? 'tour-icon tour-icon--primary' : 'tour-icon'}${props.class ? ` ${props.class}` : ''}`}
      aria-label={props.label}
      title={props.tooltip ?? props.label}
      disabled={props.disabled}
      aria-pressed={props.pressed}
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  );
}
