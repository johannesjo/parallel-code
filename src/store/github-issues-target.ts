import { store } from './core';
import { isGitHubProject, openGitHubIssues } from './github';
import { planViewProjectId } from './kanban';
import { showNotification } from './notification';
import { projectPageOpen } from './project-pages';
import { isPlannableProject } from './projects';

/** Why there are no GitHub issues to open: nothing names a project. */
export const NO_GITHUB_ISSUES_TARGET = 'Select a project or task to see its GitHub issues';

/**
 * The project whose GitHub issues the board button and shortcut open: the open
 * plan's, else the selected project, else the active task's. With all projects
 * showing the active task still names one, so the sidebar need not be opened
 * to pick it. Null without any of them.
 */
export function githubIssuesTargetProjectId(): string | null {
  if (isPlannableProject(store.kanbanProjectId)) return store.kanbanProjectId;
  const selected = planViewProjectId();
  if (selected) return selected;
  const id = store.activeTaskId;
  const taskProject = id ? store.tasks[id]?.projectId : undefined;
  return taskProject && isPlannableProject(taskProject) ? taskProject : null;
}

/** Closes the GitHub issues page, or opens it for the project in context. */
export function toggleGitHubIssues(): void {
  if (projectPageOpen()) {
    openGitHubIssues(null);
    return;
  }
  const project = store.projects.find((p) => p.id === githubIssuesTargetProjectId());
  if (!project) {
    showNotification(NO_GITHUB_ISSUES_TARGET);
    return;
  }
  // Same answer as the board button, which is disabled for a known non-GitHub
  // project; while gh is still asked, the page reports a failure itself.
  if (isGitHubProject(project.path) === false)
    showNotification(`GitHub issues unavailable for ${project.name}`);
  else openGitHubIssues(project.id);
}
