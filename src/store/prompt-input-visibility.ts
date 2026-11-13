import { setStore, store } from './core';
import type { Task } from './types';

/**
 * Shows one task's prompt box for a draft the app staged (a canvas request,
 * a browser reference, a review), without touching the user's "Show prompt
 * input box" preference. Sending the prompt hides it again.
 */
export function revealTaskPromptInput(taskId: string): void {
  if (!store.tasks[taskId] || store.tasks[taskId].promptInputRevealed) return;
  setStore('tasks', taskId, 'promptInputRevealed', true);
}

export function concealTaskPromptInput(taskId: string): void {
  if (!store.tasks[taskId]?.promptInputRevealed) return;
  setStore('tasks', taskId, 'promptInputRevealed', undefined);
}

/** Whether the task's prompt box shows: the preference, or a staged draft. */
export function isTaskPromptInputShown(
  task: Pick<Task, 'promptInputRevealed'> | undefined,
): boolean {
  return store.showPromptInput || task?.promptInputRevealed === true;
}
