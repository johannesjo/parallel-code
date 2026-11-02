import { type JSX } from 'solid-js';
import './toggle-group.css';

/**
 * A row of toggle buttons in one frame, sized to the title bar's icon buttons.
 * The pressed button shows its state with a subtle fill only.
 */
export function ToggleGroup(props: { label: string; children: JSX.Element }) {
  return (
    <div class="toggle-group" role="group" aria-label={props.label}>
      {props.children}
    </div>
  );
}

interface ToggleButtonProps {
  pressed: boolean;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  /** Names an icon-only button; text buttons are named by their text. */
  label?: string;
  ref?: (el: HTMLButtonElement) => void;
  children: JSX.Element;
}

/** One button of a ToggleGroup. */
export function ToggleButton(props: ToggleButtonProps) {
  return (
    <button
      ref={props.ref}
      type="button"
      title={props.title}
      aria-label={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={(event) => {
        // The title bar treats clicks on its background as window drags.
        event.stopPropagation();
        props.onClick();
      }}
    >
      {props.children}
    </button>
  );
}
