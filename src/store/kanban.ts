/** Renderer side of the project Kanban board (KANBAN.md at the project root). */
import { createEffect, createRoot, on } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { errMessage, warn as logWarn } from '../lib/log';
import {
  DEFAULT_KANBAN_MARKDOWN,
  addIssueCard,
  advanceCardForBranch,
  findCardByIssue,
  buildKanbanPlanPrompt,
  buildKanbanTaskPrompt,
  findCard,
  linkCardToBranch,
  parseKanban,
  serializeKanban,
  type KanbanBoard,
  type KanbanCardRef,
} from '../lib/kanban';
import { setStore, store } from './core';
import { ensureProjectAgentTask } from './github-agent';
import { setPrefillPrompt } from './tasks';
import { kanbanAgentTaskId } from '../documents/task-id';
import { toggleNewTaskPanel } from './navigation';
import { showNotification } from './notification';
import { getPrChecks } from './pr-checks-state';
import { getProjectPath } from './projects';
import type { KanbanNewTaskSource, Project, Task } from './types';

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

const CONFLICT_RETRIES = 3;

/**
 * Re-reads the board, applies `change` and writes it back. `change` returns
 * null to leave the file alone. A write that loses a race with another edit
 * (the open board, an editor, an agent) is retried on the new text.
 * Returns whether the file changed; false also when there is no board.
 */
export async function updateKanbanFile(
  projectRoot: string,
  change: (board: KanbanBoard) => KanbanBoard | null,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    const current = await readKanbanFile(projectRoot);
    if (current === null) return false;
    const next = change(parseKanban(current));
    if (!next) return false;
    const content = serializeKanban(next);
    if (content === current) return false;
    try {
      await writeKanbanFile(projectRoot, content, current);
      return true;
    } catch (err) {
      if (attempt >= CONFLICT_RETRIES || !/changed on disk/.test(errMessage(err))) throw err;
    }
  }
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
    // A card tracking an issue links its task to it, as the GitHub page does.
    ...(card.issue ? { githubUrl: card.issue } : {}),
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
  if (!task || source.projectId !== projectId) return;
  // Only a worktree task has a branch of its own; a direct task works on the
  // base branch, which every other direct task shares.
  if (task.gitIsolation !== 'worktree' || !task.branchName) {
    showNotification(
      `The task works without its own branch, so it was not linked to "${source.title}"`,
    );
    return;
  }
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) return;
  let missing = false;
  try {
    await updateKanbanFile(projectRoot, (board) => {
      const ref = findCard(board, source);
      missing = !ref;
      return ref ? linkCardToBranch(board, ref, task.branchName).board : null;
    });
    if (missing) {
      showNotification(`Card "${source.title}" is no longer on the board; the task was not linked`);
    }
  } catch (err) {
    logWarn('kanban', 'could not link task to card', { taskId, error: errMessage(err) });
    showNotification(`Could not link the task to its Kanban card: ${errMessage(err)}`);
  }
}

/** Moves the card of `branch` forward on its project's board; quiet when there is none. */
export async function advanceKanbanCard(
  projectId: string,
  branch: string,
  stage: 'review' | 'done',
): Promise<void> {
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot || !branch) return;
  try {
    await updateKanbanFile(projectRoot, (board) => advanceCardForBranch(board, branch, stage));
  } catch (err) {
    logWarn('kanban', 'could not move card', { projectId, branch, stage, error: errMessage(err) });
  }
}

/** Whether a task has handed its work over: the agent signalled done, or a PR is open. */
function taskReachedReview(task: Task): boolean {
  return Boolean(
    task.needsReview ||
    task.signalDoneReceived ||
    task.prUrl ||
    task.landingState === 'landed_pending_review',
  );
}

/** The task's work is in: landed by the coordinator, or its PR merged on GitHub. */
function taskLanded(task: Task): boolean {
  return task.landingState === 'reviewed' || getPrChecks(task.id)?.merged === true;
}

/**
 * Keeps cards in step with their tasks while the app runs: a task that reaches
 * review moves its card to the Review column, a landed one or one whose PR
 * merged to Done. Only transitions seen while running count; a task's state at
 * startup is the baseline, though PR checks arrive later and may then report a
 * merge. Each task moves its card at most once per stage, so a card dragged
 * back by hand stays put. Merges done from the app are reported by their
 * callers (the merge dialog and the phone handler).
 */
export function startKanbanAutomation(): () => void {
  return createRoot((dispose) => {
    const seen = new Map<string, { review: boolean; landed: boolean }>();
    const moved = new Set<string>();
    const advanceOnce = (
      task: { id: string; projectId: string; branch: string },
      stage: 'review' | 'done',
    ) => {
      const key = `${task.id}:${stage}`;
      if (moved.has(key)) return;
      moved.add(key);
      void advanceKanbanCard(task.projectId, task.branch, stage);
    };
    createEffect(
      on(
        () =>
          Object.values(store.tasks).map((task) =>
            task && task.gitIsolation === 'worktree'
              ? {
                  id: task.id,
                  projectId: task.projectId,
                  branch: task.branchName,
                  review: taskReachedReview(task),
                  landed: taskLanded(task),
                }
              : null,
          ),
        (tasks) => {
          const present = new Set<string>();
          for (const task of tasks) {
            if (!task) continue;
            present.add(task.id);
            const before = seen.get(task.id);
            seen.set(task.id, { review: task.review, landed: task.landed });
            if (!before) continue;
            if (task.landed && !before.landed) advanceOnce(task, 'done');
            else if (task.review && !before.review) advanceOnce(task, 'review');
          }
          for (const id of seen.keys()) if (!present.has(id)) seen.delete(id);
          for (const key of moved)
            if (!present.has(key.slice(0, key.lastIndexOf(':')))) moved.delete(key);
        },
      ),
    );
    return dispose;
  });
}

/**
 * Puts a planning prompt for `goal` in the board agent's prompt box, to edit
 * and send. An unsent draft in that box is left alone.
 */
export function prefillKanbanPlanPrompt(project: Project, goal = ''): boolean {
  const task = ensureProjectAgentTask(kanbanAgentTaskId(project.id), project);
  if (!task) return false;
  if ((task.prefillPrompt ?? task.promptDraft ?? '').trim()) return true;
  setPrefillPrompt(task.id, buildKanbanPlanPrompt(goal));
  return true;
}

/**
 * Adds GitHub issues or PRs to the project's board as cards in the first
 * column, skipping any it already tracks and creating the board if the
 * project has none. Returns how many cards were added, or null on failure.
 */
export async function addIssuesToBoard(
  projectId: string,
  items: readonly { title: string; url: string }[],
): Promise<number | null> {
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) return null;
  try {
    if ((await readKanbanFile(projectRoot)) === null) {
      // Another writer may create it first; the update below works on either.
      await writeKanbanFile(projectRoot, DEFAULT_KANBAN_MARKDOWN, null).catch(() => undefined);
    }
    let added = 0;
    await updateKanbanFile(projectRoot, (board) => {
      added = 0;
      const next = items.reduce((current, item) => {
        const updated = addIssueCard(current, item);
        if (updated !== current) added++;
        return updated;
      }, board);
      return next === board ? null : next;
    });
    return added;
  } catch (err) {
    logWarn('kanban', 'could not add issues to board', { projectId, error: errMessage(err) });
    showNotification(`Could not add to the Kanban board: ${errMessage(err)}`);
    return null;
  }
}

/** The board column a GitHub issue or PR sits in, or null when it is not on the board. */
export async function issueBoardColumn(projectId: string, url: string): Promise<string | null> {
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) return null;
  const text = await readKanbanFile(projectRoot).catch(() => null);
  if (text === null) return null;
  const board = parseKanban(text);
  const ref = findCardByIssue(board, url);
  return ref ? (board.columns[ref.column]?.title ?? null) : null;
}
