import { isGitHubAgentTaskId } from './github-list.js';

const KANBAN_AGENT_PREFIX = 'kanban-agent-';

/** The Kanban board's planning agent; its own session, apart from the GitHub page's. */
export function kanbanAgentTaskId(projectId: string): string {
  return `${KANBAN_AGENT_PREFIX}${projectId}`;
}

export function isKanbanAgentTaskId(id: string | null): boolean {
  return id?.startsWith(KANBAN_AGENT_PREFIX) === true;
}

/**
 * A project page's agent lives on its page; activating it as a task would close the page.
 * Shared with the main process, which lets these agents create independent tasks.
 */
export function isProjectPageAgentTaskId(id: string | null): boolean {
  return isGitHubAgentTaskId(id) || isKanbanAgentTaskId(id);
}
