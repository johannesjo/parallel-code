import type { Project } from '../store/types';
import { githubAgentTaskId, isGitHubAgentTaskId } from '../../electron/shared/github-list';
import { isKanbanAgentTaskId, kanbanAgentTaskId } from '../../electron/shared/project-page-agents';

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

// Shared with the main process, which lets page agents create independent tasks.
export {
  isKanbanAgentTaskId,
  isProjectPageAgentTaskId,
  kanbanAgentTaskId,
} from '../../electron/shared/project-page-agents';

/** Hidden agents run in the project checkout and never appear as tasks. */
export function isHiddenAgentTaskId(id: string | null): boolean {
  return isDocumentAgentTaskId(id) || isGitHubAgentTaskId(id) || isKanbanAgentTaskId(id);
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
