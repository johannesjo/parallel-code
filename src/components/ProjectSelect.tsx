import { For, Show } from 'solid-js';
import { store } from '../store/store';

interface ProjectSelectProps {
  value: string | null;
  onChange: (projectId: string | null) => void;
  placeholder?: string;
  class?: string;
}

export function ProjectSelect(props: ProjectSelectProps) {
  return (
    <select
      class={`project-select${props.class ? ` ${props.class}` : ''}`}
      value={props.value ?? ''}
      onChange={(e) => props.onChange(e.currentTarget.value || null)}
    >
      <Show when={props.placeholder}>
        <option value="" disabled hidden>
          {props.placeholder}
        </option>
      </Show>
      <For each={[...store.projects].sort((a, b) => a.name.localeCompare(b.name))}>
        {(project) => (
          <option value={project.id}>
            {project.name} — {project.path}
          </option>
        )}
      </For>
    </select>
  );
}
