import { store } from './core';

/** A removed project must never leave the workspace stuck behind a stale filter. */
export function taskProjectFilter(): string | null {
  return store.projects.some((project) => project.id === store.taskProjectFilter)
    ? store.taskProjectFilter
    : null;
}

export function matchesTaskProjectFilter(taskId: string): boolean {
  const projectId = taskProjectFilter();
  // Standalone terminals belong to the workspace, not to a project.
  return !projectId || !!store.terminals?.[taskId] || store.tasks[taskId]?.projectId === projectId;
}
