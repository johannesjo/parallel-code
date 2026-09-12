import type { Project } from '../store/types';

const TASK_ID_PREFIX = 'doc-agent-';

/** Stable across workspace closes and app restarts. */
export function documentAgentTaskId(projectId: string): string {
  return `${TASK_ID_PREFIX}${projectId}`;
}

/** The same hidden tasks must be serialized, restored and observed by autosave. */
export function documentAgentTaskIds(projects: readonly Project[]): string[] {
  return projects.filter((p) => p.kind === 'document').map((p) => documentAgentTaskId(p.id));
}

/** Document tasks have no worktree to merge, push or close. */
export function isDocumentAgentTaskId(id: string | null): boolean {
  return id?.startsWith(TASK_ID_PREFIX) === true;
}
