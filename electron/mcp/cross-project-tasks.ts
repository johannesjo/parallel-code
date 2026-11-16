/** A project that takes tasks, as the renderer lists it. */
export interface TaskProject {
  id: string;
  name: string;
}

/** What the user is asked before an agent creates a task in another project. */
export interface CrossProjectTaskRequest {
  creatorTaskName: string;
  projectName: string;
  targetProjectName: string;
  name: string;
  prompt: string;
}

const LISTED_PROJECTS = 30;

function describe(projects: readonly TaskProject[], withIds: boolean): string {
  const shown = projects
    .slice(0, LISTED_PROJECTS)
    .map((p) => (withIds ? `"${p.name}" (id ${p.id})` : `"${p.name}"`));
  const more = projects.length - shown.length;
  return shown.join(', ') + (more > 0 ? ` and ${more} more` : '');
}

/**
 * Finds the project an agent named, by exact id or by name ignoring case. Agents usually
 * know a project by name ("phpstan"), so an unknown or ambiguous name returns an error
 * message that lists the choices.
 */
export function resolveTaskProject(
  projects: readonly TaskProject[],
  ref: string,
): TaskProject | string {
  const byId = projects.find((p) => p.id === ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  const byName = projects.filter((p) => p.name.trim().toLowerCase() === wanted);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1)
    return `Several projects are named "${ref}"; pass the id of one of them as project: ${describe(byName, true)}`;
  return projects.length
    ? `No project is named "${ref}". Projects: ${describe(projects, false)}`
    : `No project is named "${ref}"`;
}
