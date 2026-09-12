/** Size of the mark in px; call sites match the text they sit next to. */
const DEFAULT_SIZE = 8;

/**
 * The project's color mark. Deliberately a rounded square, not a circle: the
 * circle family belongs to task status (StatusDot's dot, spinner and "?"), and
 * the two appear a line apart in the task header and stacked in the sidebar
 * tray. Shape separates the axes so hue never has to.
 */
export function ProjectSwatch(props: { color: string; size?: number; title?: string }) {
  const size = () => `${props.size ?? DEFAULT_SIZE}px`;
  return (
    <span
      class="project-swatch"
      aria-hidden="true"
      title={props.title}
      style={{
        display: 'inline-block',
        width: size(),
        height: size(),
        'border-radius': '2px',
        background: props.color,
        'flex-shrink': '0',
      }}
    />
  );
}
