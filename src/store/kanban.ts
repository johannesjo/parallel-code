/** Renderer side of the project Kanban board (KANBAN.md at the project root). */
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { errMessage, warn as logWarn } from '../lib/log';
import {
  buildKanbanTaskPrompt,
  findCard,
  linkCardToBranch,
  parseKanban,
  serializeKanban,
  type KanbanBoard,
  type KanbanCardRef,
} from '../lib/kanban';
import { setStore, store } from './core';
import { toggleNewTaskPanel } from './navigation';
import { showNotification } from './notification';
import { getProjectPath } from './projects';
import type { KanbanNewTaskSource } from './types';

/** Opens the board page for a project, or returns to the tasks with null. */
export function openKanban(projectId: string | null): void {
  if (projectId) setStore('githubIssuesProjectId', null);
  setStore('kanbanProjectId', projectId);
}

/** The board's Markdown, or null when the project has none yet. */
export function readKanbanFile(projectRoot: string): Promise<string | null> {
  return invoke<string | null>(IPC.ReadKanbanBoard, { projectRoot });
}

/** Writes the board; refused when the file no longer holds `expected` (null: absent). */
export function writeKanbanFile(
  projectRoot: string,
  content: string,
  expected: string | null,
): Promise<void> {
  return invoke(IPC.WriteKanbanBoard, { projectRoot, content, expected });
}

/**
 * Opens the new-task form prefilled from a card. Never replaces an open
 * composer or its unsent draft. The task is linked to the card once created.
 */
export function startKanbanCardTask(
  projectId: string,
  board: KanbanBoard,
  ref: KanbanCardRef,
): boolean {
  if (store.showNewTaskPanel) return false;
  const column = board.columns[ref.column];
  const card = column?.cards[ref.card];
  if (!column || !card) return false;
  setStore('newTaskPrefillPrompt', {
    projectId,
    name: card.title,
    prompt: buildKanbanTaskPrompt(board, ref),
    kanban: { projectId, title: card.title, column: column.title, ref: { ...ref } },
  });
  openKanban(null);
  toggleNewTaskPanel(true);
  return true;
}

/**
 * Writes the new task's branch under the card it was started from, and moves
 * the card to "In progress". Re-reads the file first, so edits made meanwhile
 * are kept; a card that was renamed or removed meanwhile is left alone.
 */
export async function linkNewTaskToKanbanCard(
  taskId: string,
  source: KanbanNewTaskSource,
  projectId: string,
): Promise<void> {
  const task = store.tasks[taskId];
  // The card describes its own project's work.
  if (!task?.branchName || source.projectId !== projectId) return;
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) return;
  try {
    const current = await readKanbanFile(projectRoot);
    if (current === null) return;
    const board = parseKanban(current);
    const ref = findCard(board, source);
    if (!ref) {
      showNotification(`Card "${source.title}" is no longer on the board; the task was not linked`);
      return;
    }
    const linked = linkCardToBranch(board, ref, task.branchName);
    await writeKanbanFile(projectRoot, serializeKanban(linked.board), current);
  } catch (err) {
    logWarn('kanban', 'could not link task to card', { taskId, error: errMessage(err) });
    showNotification(`Could not link the task to its Kanban card: ${errMessage(err)}`);
  }
}
