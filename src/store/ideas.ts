import { createSignal } from 'solid-js';
import { setStore, store } from './core';
import { toggleNewTaskPanel } from './navigation';
import { codeProjects } from './projects';
import { taskProjectFilter } from './task-project-filter';
import type { TaskIdea } from './types';

// shortcut: not persisted, so the lane starts hidden after a restart — a store
// field in PersistedState if users want it remembered.
const [ideasLaneShown, setIdeasLaneShown] = createSignal(false);
export { ideasLaneShown, setIdeasLaneShown };

/**
 * Ideas on the board, newest first, narrowed like its tasks. An idea without
 * a project belongs to every project, so a filter never hides it.
 */
export function boardIdeas(query: string): TaskIdea[] {
  const projectId = taskProjectFilter();
  const needle = query.trim().toLowerCase();
  return store.taskIdeas.filter(
    (idea) =>
      (!projectId || !idea.projectId || idea.projectId === projectId) &&
      idea.text.toLowerCase().includes(needle),
  );
}

export function addTaskIdea(text: string, projectId: string | null): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  // The first idea in view brings its lane up; later ones respect a hidden lane.
  if (boardIdeas('').length === 0) setIdeasLaneShown(true);
  const idea: TaskIdea = {
    id: crypto.randomUUID(),
    text: trimmed,
    projectId,
    createdAt: Date.now(),
  };
  setStore('taskIdeas', (ideas) => [idea, ...ideas]);
  setStore('lastIdeaProjectId', projectId);
}

/**
 * Where a new idea goes unless picked otherwise: the project the board is
 * filtered to, else the one the last idea went to, while it still exists.
 */
export function defaultIdeaProject(): string | null {
  const last = store.lastIdeaProjectId;
  const lastExists = codeProjects().some((project) => project.id === last);
  return taskProjectFilter() ?? (lastExists ? last : null);
}

/** Rewrites an idea's text; an empty edit keeps the old text. */
export function updateTaskIdea(id: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  setStore('taskIdeas', (idea) => idea.id === id, 'text', trimmed);
}

export function removeTaskIdea(id: string): void {
  setStore('taskIdeas', (ideas) => ideas.filter((idea) => idea.id !== id));
}

/**
 * Opens the new-task form prefilled with the idea. Never replaces an open
 * composer or its unsent draft. The idea leaves the board once the task exists.
 */
export function startTaskIdea(id: string): boolean {
  const idea = store.taskIdeas.find((i) => i.id === id);
  if (!idea || store.showNewTaskPanel) return false;
  setStore('newTaskDropUrl', null);
  // An empty name lets the model name the task from the prompt.
  setStore('newTaskPrefillPrompt', {
    prompt: idea.text,
    name: '',
    projectId: idea.projectId,
    ideaId: idea.id,
  });
  toggleNewTaskPanel(true);
  return true;
}
