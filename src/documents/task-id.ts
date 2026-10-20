import type { Project } from '../store/types';
import { githubAgentTaskId, isGitHubAgentTaskId } from '../../electron/shared/github-list';

const TASK_ID_PREFIX = 'doc-agent-';

/** Stable across workspace closes and app restarts. */
export function documentAgentTaskId(projectId: string): string {
  return `${TASK_ID_PREFIX}${projectId}`;
}

/** Document tasks have no worktree to merge, push or close. */
export function isDocumentAgentTaskId(id: string | null): boolean {
  return id?.startsWith(TASK_ID_PREFIX) === true;
}

// The prefix is shared with the MCP server, which offers list publishing only to this agent.
export { githubAgentTaskId, isGitHubAgentTaskId } from '../../electron/shared/github-list';

const KANBAN_AGENT_PREFIX = 'kanban-agent-';

/** The Kanban board's planning agent; its own session, apart from the GitHub page's. */
export function kanbanAgentTaskId(projectId: string): string {
  return `${KANBAN_AGENT_PREFIX}${projectId}`;
}

export function isKanbanAgentTaskId(id: string | null): boolean {
  return id?.startsWith(KANBAN_AGENT_PREFIX) === true;
}

/** Hidden agents run in the project checkout and never appear as tasks. */
export function isHiddenAgentTaskId(id: string | null): boolean {
  return isDocumentAgentTaskId(id) || isGitHubAgentTaskId(id) || isKanbanAgentTaskId(id);
}

/** A project page's agent lives on its page; activating it as a task would close the page. */
export function isProjectPageAgentTaskId(id: string | null): boolean {
  return isGitHubAgentTaskId(id) || isKanbanAgentTaskId(id);
}

/** The hidden agent tasks a project can have. */
export function projectHiddenAgentTaskIds(project: Pick<Project, 'id' | 'kind'>): string[] {
  return project.kind === 'document'
    ? [documentAgentTaskId(project.id)]
    : [githubAgentTaskId(project.id), kanbanAgentTaskId(project.id)];
}

/** Hidden tasks are serialized, restored and observed by autosave; ids without a task are skipped. */
export function hiddenAgentTaskIds(projects: readonly Project[]): string[] {
  return projects.flatMap(projectHiddenAgentTaskIds);
}
