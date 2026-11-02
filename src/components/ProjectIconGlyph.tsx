import { For } from 'solid-js';
import type { ProjectIconId } from '../lib/project-icon';
import { PROJECT_ICON_PATHS } from '../lib/project-icon-paths';

/** A project icon drawn in `currentColor`, so callers tint it with the project color. */
export function ProjectIconGlyph(props: { icon: ProjectIconId; size: number }) {
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <For each={PROJECT_ICON_PATHS[props.icon]}>{(d) => <path d={d} />}</For>
    </svg>
  );
}
