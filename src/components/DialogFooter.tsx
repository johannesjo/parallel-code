import type { JSX } from 'solid-js';

interface DialogFooterProps {
  /** Shown beside the buttons in an always-present alert slot, so it never shifts them. */
  error?: string | null;
  /** Quiet text beside the buttons, before any error. */
  note?: JSX.Element;
  /** Left-aligned action set apart from the main ones, e.g. Delete. */
  start?: JSX.Element;
  style?: JSX.CSSProperties;
  children: JSX.Element;
}

/**
 * Action row for dialogs. Buttons inside use `btn-secondary`, `btn-primary`
 * or `btn-danger`; the footer gives them one size and look.
 */
export function DialogFooter(props: DialogFooterProps) {
  return (
    <div class="dialog-footer" style={props.style}>
      {props.start}
      <span class="dialog-footer-lead">
        {props.note}
        {/* Always in the DOM: screen readers announce changes to a live region,
            not one inserted along with its message. */}
        <span role="alert" class="dialog-footer-error">
          {props.error}
        </span>
      </span>
      {/* One group, so a footer too narrow for everything moves the note above
          the buttons rather than splitting the buttons across rows. */}
      <span class="dialog-footer-actions">{props.children}</span>
    </div>
  );
}
