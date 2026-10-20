/** Agent-published GitHub issue lists, saved per project and repository in localStorage. */
import { createSignal } from 'solid-js';
import { parseGitHubList, type GitHubCustomList } from '../../electron/shared/github-list';
import { store } from './core';
import { githubAgentTaskId } from '../documents/task-id';
import { resolveGitHubRepository } from './github';
import { githubListsKey } from './github-list-storage';
import { showNotification } from './notification';

const MAX_LISTS = 20;

export interface ShownGitHubList {
  projectId: string;
  repository: string;
  name: string;
}

// localStorage is not reactive; bumping this re-reads every list view.
const [revision, setRevision] = createSignal(0);
const [shownList, setShownList] = createSignal<ShownGitHubList | null>(null);

/** The list the GitHub page shows instead of search results, if any. */
export { shownList as shownGitHubList };

export function showGitHubList(list: ShownGitHubList | null): void {
  setShownList(list);
}

/**
 * Saved lists, oldest first. Throws when the stored data is not a JSON array;
 * entries that no longer parse are dropped so one bad list keeps the others.
 */
export function loadGitHubLists(projectId: string, repository: string): GitHubCustomList[] {
  revision();
  const saved: unknown = JSON.parse(
    localStorage.getItem(githubListsKey(projectId, repository)) ?? '[]',
  );
  if (!Array.isArray(saved)) throw new Error('Saved lists are not an array.');
  return saved.slice(-MAX_LISTS).flatMap((entry): GitHubCustomList[] => {
    try {
      return [parseGitHubList(entry).list];
    } catch {
      return [];
    }
  });
}

export function deleteGitHubList(projectId: string, repository: string, name: string): void {
  let next: GitHubCustomList[];
  try {
    next = loadGitHubLists(projectId, repository).filter((list) => list.name !== name);
  } catch {
    // Unreadable data cannot be shown, so deleting is how the user clears it.
    next = [];
  }
  if (next.length)
    localStorage.setItem(githubListsKey(projectId, repository), JSON.stringify(next));
  else localStorage.removeItem(githubListsKey(projectId, repository));
  setRevision((v) => v + 1);
  const shown = shownList();
  if (
    shown?.projectId === projectId &&
    shown.repository === repository.toLowerCase() &&
    shown.name === name
  )
    setShownList(null);
}

/**
 * Saves a list the project's GitHub agent published. A list with the same name
 * is replaced; past twenty, the oldest goes. It becomes the project page's shown
 * list, unless the user is on another project's GitHub page.
 */
export async function publishGitHubList(taskId: string, value: unknown): Promise<void> {
  const projectId = store.tasks[taskId]?.projectId;
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) throw new Error('The task’s project was removed.');
  if (project.kind === 'document') throw new Error('Document projects have no GitHub page.');
  // Any other task would otherwise pull the user away from their own work.
  if (taskId !== githubAgentTaskId(project.id))
    throw new Error('Only the project’s GitHub page agent can publish GitHub lists.');
  const { repository, list } = parseGitHubList(value);
  const projectRepository = await resolveGitHubRepository(project.path);
  // Removal forgets the project's lists; saving after it would orphan the key.
  if (!store.projects.some((p) => p.id === project.id))
    throw new Error('The task’s project was removed.');
  if (projectRepository.toLowerCase() !== repository)
    throw new Error(
      `The list is for ${repository}, but this project’s repository is ${projectRepository}.`,
    );
  let saved: GitHubCustomList[];
  try {
    saved = loadGitHubLists(project.id, repository);
  } catch {
    // Not a JSON array, so there is nothing to keep; the new list replaces it.
    saved = [];
  }
  const next = [...saved.filter((l) => l.name !== list.name), list].slice(-MAX_LISTS);
  localStorage.setItem(githubListsKey(project.id, repository), JSON.stringify(next));
  setRevision((v) => v + 1);
  const viewing = store.githubIssuesProjectId;
  // One shown list serves every page: selecting this one would blank another project's view.
  if (!viewing || viewing === project.id)
    setShownList({ projectId: project.id, repository, name: list.name });
  // The user left the page mid-run; say where the list went.
  if (viewing !== project.id)
    showNotification(`List “${list.name}” is ready on ${project.name}’s GitHub page.`);
}
