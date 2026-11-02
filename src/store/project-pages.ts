import { batch } from 'solid-js';
import { store, setStore } from './core';

/** Whether a project page (GitHub issues) covers the task area. */
export function projectPageOpen(): boolean {
  return store.projects.some((p) => p.id === store.githubIssuesProjectId);
}

/**
 * Whether the board is on screen, showing all tasks or a project's plan
 * (`kanbanProjectId`); a project page covers it while open.
 */
export function boardShown(): boolean {
  return store.boardView && !projectPageOpen();
}

/** Whether the all-tasks board shows the active task, or a new-task draft, beside it. */
export function boardSidePanelOpen(): boolean {
  return store.boardView && (store.boardPeek || store.showNewTaskPanel);
}

/** Whether the all-tasks board hides the task workspace: open, without its side panel. */
export function boardCoversWorkspace(): boolean {
  return store.boardView && !boardSidePanelOpen();
}

/** Opens the board's side panel; the task to show is whichever becomes active. */
export function openBoardSidePanel(): void {
  setStore('boardPeek', true);
}

export function closeBoardSidePanel(): void {
  setStore('boardPeek', false);
}

/** Moves the side panel to the board's other side; the choice persists. */
export function toggleBoardSidePanelSide(): void {
  setStore('boardSidePanelLeft', !store.boardSidePanelLeft);
}

/** The arrow key that leads from the side panel towards the board beside it. */
export function towardBoard(): 'left' | 'right' {
  return store.boardSidePanelLeft ? 'right' : 'left';
}

/** Closes the board; it opens again on all tasks, not on the plan it showed. */
export function closeBoard(): void {
  batch(() => {
    setStore('boardView', false);
    setStore('boardPeek', false);
    setStore('kanbanProjectId', null);
  });
}

/**
 * Closes whichever page (GitHub issues or the board) covers the task area.
 * Every path that shows a task or another workspace calls this, so a new page
 * type only has to be added here. The board, all tasks or a plan, stays while
 * its side panel is open, or with `keepBoard`: the task or draft then shows in
 * that panel.
 */
export function closeProjectPages(opts: { keepBoard?: boolean } = {}): void {
  batch(() => {
    setStore('githubIssuesProjectId', null);
    if (!opts.keepBoard && !boardSidePanelOpen()) closeBoard();
  });
}
