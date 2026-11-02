import { Show } from 'solid-js';
import type { ProjectIconId } from '../lib/project-icon';
import { ProjectIconGlyph } from './ProjectIconGlyph';

/** Size of the mark in px; call sites match the text they sit next to. */
const DEFAULT_SIZE = 8;

/**
 * The project's color mark. Deliberately a rounded square, not a circle: the
 * circle family belongs to task status (StatusDot's dot, spinner and "?"), and
 * the two appear a line apart in the task header and stacked in the sidebar
 * tray. Shape separates the axes so hue never has to.
 *
 * A project icon replaces the square, drawn in the project color. It renders a
 * few px larger than `size` because a glyph at the square's size is unreadable.
 */
export function ProjectSwatch(props: {
  color: string;
  icon?: ProjectIconId;
  size?: number;
  title?: string;
}) {
  const sizePx = () => props.size ?? DEFAULT_SIZE;
  return (
    <Show
      when={props.icon}
      fallback={
        <span
          class="project-swatch"
          aria-hidden="true"
          title={props.title}
          style={{
            display: 'inline-block',
            width: `${sizePx()}px`,
            height: `${sizePx()}px`,
            'border-radius': '2px',
            background: props.color,
            'flex-shrink': '0',
          }}
        />
      }
    >
      {(icon) => (
        <span
          class="project-swatch project-swatch-icon"
          aria-hidden="true"
          title={props.title}
          style={{ display: 'inline-flex', color: props.color, 'flex-shrink': '0' }}
        >
          <ProjectIconGlyph icon={icon()} size={sizePx() + 4} />
        </span>
      )}
    </Show>
  );
}
