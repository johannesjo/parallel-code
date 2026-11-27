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
  /** The creator's container, which the new task runs in too; null when it runs on the host. */
  docker: { image?: string } | null;
}

/** A prompt the confirmation dialog shows whole, so the user never approves text unseen. */
export const CROSS_PROJECT_PROMPT_MAX_CHARS = 1500;
export const CROSS_PROJECT_PROMPT_MAX_LINES = 30;

/** Why a prompt cannot go to another project, or undefined when the dialog shows all of it. */
export function crossProjectPromptProblem(prompt: string): string | undefined {
  const lines = prompt.split(/\r\n|[\r\n\u2028\u2029]/).length;
  if (prompt.length <= CROSS_PROJECT_PROMPT_MAX_CHARS && lines <= CROSS_PROJECT_PROMPT_MAX_LINES)
    return undefined;
  return (
    `A task in another project takes a prompt of at most ${CROSS_PROJECT_PROMPT_MAX_CHARS} characters and ${CROSS_PROJECT_PROMPT_MAX_LINES} lines, ` +
    `so the user reads all of it before allowing it; this one has ${prompt.length} characters and ${lines} line${lines === 1 ? '' : 's'}. ` +
    'Shorten it and call again with a new requestId; put longer details in an issue the new task can read.'
  );
}

/** The confirmation dialog's headline and body. */
export function crossProjectTaskDialog(request: CrossProjectTaskRequest): {
  message: string;
  detail: string;
} {
  const sandbox = request.docker
    ? `Docker, image ${request.docker.image ?? 'default'}, as the asking task`
    : 'none, the agent runs directly on this computer';
  return {
    message: `An agent in project "${request.projectName}" wants to create a task in project "${request.targetProjectName}".`,
    // Names and prompts come from agents, so they stay out of the headline the user acts on.
    detail: [
      `Asking task: ${request.creatorTaskName.slice(0, 80)}`,
      `New task: ${request.name.slice(0, 80)}`,
      'Permission prompts: on, as for every task an agent creates in another project',
      `Sandbox: ${sandbox}`,
      '',
      'Prompt, in full:',
      request.prompt,
      '',
      `If you allow it, the task starts in "${request.targetProjectName}" with the asking agent, and you review it like any other task.`,
    ].join('\n'),
  };
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
