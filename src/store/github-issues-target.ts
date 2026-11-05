import { store } from './core';
import { isGitHubProject, openGitHubIssues } from './github';
import { planViewProjectId } from './kanban';
import { showNotification } from './notification';
import { projectPageOpen } from './project-pages';
import { isPlannableProject } from './projects';

/** Why there are no GitHub issues to open: nothing names a project. */
const NO_GITHUB_ISSUES_TARGET = 'Select a project or task to see its GitHub issues';

/** The project the board is explicitly on: the open plan's, else the selected one. */
export function selectedGitHubProjectId(): string | null {
  if (isPlannableProject(store.kanbanProjectId)) return store.kanbanProjectId;
  return planViewProjectId();
}

/**
 * The project whose GitHub issues the shortcut opens: the selected one (see
 * selectedGitHubProjectId), else the active task's. A keystroke has no menu to
 * pick from, so the active task stands in; the board button offers a menu
 * instead. Null without any of them.
 */
function githubIssuesTargetProjectId(): string | null {
  const selected = selectedGitHubProjectId();
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
  // Same answer as the board button, which disables a known non-GitHub
  // project; while gh is still asked, the page reports a failure itself.
  if (isGitHubProject(project.path) === false)
    showNotification(`GitHub issues unavailable for ${project.name}`);
  else openGitHubIssues(project.id);
}
