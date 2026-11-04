import { For, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { codeProjects } from '../store/projects';
import { ProjectSwatch } from './ProjectSwatch';

interface ProjectSelectProps {
  value: string | null;
  onChange: (projectId: string | null) => void;
  placeholder?: string;
  /** Offers "no project" as a choice, under this label. */
  emptyLabel?: string;
  class?: string;
  showPath?: boolean;
  id?: string;
}

export function ProjectSelect(props: ProjectSelectProps) {
  return (
    <select
      id={props.id}
      class={`project-select${props.class ? ` ${props.class}` : ''}`}
      value={props.value ?? ''}
      onChange={(e) => props.onChange(e.currentTarget.value || null)}
    >
      <Dynamic component="button" type="button">
        <Dynamic
          component="selectedcontent"
          style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}
        />
      </Dynamic>
      <Show when={props.placeholder}>
        <option value="" disabled hidden>
          {props.placeholder}
        </option>
      </Show>
      <Show when={props.emptyLabel}>
        <option value="">{props.emptyLabel}</option>
      </Show>
      <For each={codeProjects().sort((a, b) => a.name.localeCompare(b.name))}>
        {(project) => (
          <option value={project.id}>
            <ProjectSwatch color={project.color} icon={project.icon} />
            <span>
              {project.name}
              <Show when={props.showPath}> — {project.path}</Show>
            </span>
          </option>
        )}
      </For>
    </select>
  );
}
