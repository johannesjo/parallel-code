import { store } from './core';

/** The project a task worktree or project folder belongs to, for one-off agent
 *  calls that know only the folder they run in. */
export function projectIdForPath(path: string): string | undefined {
  const task = Object.values(store.tasks).find((t) => t.worktreePath === path);
  return task?.projectId ?? store.projects.find((p) => p.path === path)?.id;
}
