import { batch } from 'solid-js';
import { setStore } from './core';

/**
 * Closes whichever project page (GitHub issues or the Kanban board) covers the
 * task area. Every path that shows a task or another workspace calls this, so
 * a new page type only has to be added here.
 */
export function closeProjectPages(): void {
  batch(() => {
    setStore('githubIssuesProjectId', null);
    setStore('kanbanProjectId', null);
  });
}
