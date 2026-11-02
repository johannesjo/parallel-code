/** Renderer side of the project Kanban board (KANBAN.md at the project root). */
import { batch, createEffect, createRoot, on } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { cleanHandoffText } from '../lib/agent-handoff';
import { errMessage, warn as logWarn } from '../lib/log';
import {
  DEFAULT_KANBAN_MARKDOWN,
  addIssueCard,
  advanceCardForBranch,
  findCardByBranch,
  findCardByIssue,
  isArchiveColumn,
  parseGitHubIssueUrl,
  buildKanbanClusterPrompt,
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
import { setTaskProjectFilter, toggleNewTaskPanel } from './navigation';
import { showNotification } from './notification';
import { getPrChecks } from './pr-checks-state';
import { getProjectPath, isPlannableProject } from './projects';
import { taskProjectFilter } from './task-project-filter';
import { getTaskAttentionState, isTaskGitStatusKnown, type TaskAttentionState } from './taskStatus';
import type { KanbanNewTaskSource, Project, Task } from './types';

/**
 * Shows a project's plan on the board, or with null the running tasks again.
 * A plan selects its project, so every project picker names the plan's.
 */
export function openKanban(projectId: string | null): void {
  batch(() => {
    if (projectId) {
      setStore('githubIssuesProjectId', null);
      setStore('boardView', true);
      setTaskProjectFilter(projectId);
    }
    setStore('kanbanProjectId', projectId);
  });
}

/**
 * The project the Plan view shows: the selected project, which opening a plan
 * selects. Null while all projects show, which hides the Plan toggle.
 */
export function planViewProjectId(): string | null {
  const projectId = taskProjectFilter();
  return isPlannableProject(projectId) ? projectId : null;
}

/** Opens the Plan view's project plan; does nothing while there is none. */
export function openPlanView(): void {
  const projectId = planViewProjectId();
  if (projectId) openKanban(projectId);
}

/** From a plan, shows the running tasks of its project only: the filter already follows the plan. */
export function showPlanTasks(): void {
  openKanban(null);
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
    name: cleanHandoffText(card.title),
    prompt: buildKanbanTaskPrompt(board, ref),
    // A card tracking an issue links its task to it, as the GitHub page does. A
    // pull request is not linked: the task works on a fresh branch, not that PR.
    ...(parseGitHubIssueUrl(card.issue)?.kind === 'issue' ? { githubUrl: card.issue } : {}),
    kanban: { projectId, title: card.title, column: column.title, ref: { ...ref } },
  });
  // The draft opens beside the plan, which stays.
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

/**
 * Checks off the card of a closed task's branch. A card stays open while
 * another of its branches still has an open task working on it.
 */
async function completeCardOfClosedTask(projectId: string, branch: string): Promise<void> {
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot || !branch) return;
  const openOn = (other: string) =>
    Object.values(store.tasks).some(
      (task) =>
        task?.projectId === projectId &&
        task.gitIsolation === 'worktree' &&
        task.branchName === other,
    );
  try {
    await updateKanbanFile(projectRoot, (board) => {
      const ref = findCardByBranch(board, branch);
      const card = ref && board.columns[ref.column]?.cards[ref.card];
      if (!card || card.branches.some((other) => other !== branch && openOn(other))) return null;
      return advanceCardForBranch(board, branch, 'done');
    });
  } catch (err) {
    logWarn('kanban', 'could not check off card', { projectId, branch, error: errMessage(err) });
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

/**
 * Whether the task's agent is done: stopped with its work committed and nothing
 * failing. Null while that cannot be told, before git status first arrives; a
 * refresh keeps the last answer, so it is not taken for a new transition.
 */
function taskReady(
  now: { attention: TaskAttentionState; gitKnown: boolean },
  before: boolean | null | undefined,
): boolean | null {
  if (now.attention === 'ready') return true;
  if (now.attention !== 'idle' && now.attention !== 'shell_busy') return false;
  return now.gitKnown ? false : (before ?? null);
}

/** The task's work is in: landed by the coordinator, or its PR merged on GitHub. */
function taskLanded(task: Task): boolean {
  return task.landingState === 'reviewed' || getPrChecks(task.id)?.merged === true;
}

/**
 * Keeps cards in step with their tasks while the app runs: a task that reaches
 * review, or whose agent finishes with its work committed, moves its card to
 * the Review column, a landed one or one whose PR
 * merged to Done. Only transitions seen while running count; a task's state at
 * startup is the baseline, though PR checks arrive later and may then report a
 * merge. Each task moves its card at most once per stage, so a card dragged
 * back by hand stays put. Closing a task checks its card off: closed, its run is over. Merges done from the app are reported by their
 * callers (the merge dialog and the phone handler).
 */
export function startKanbanAutomation(): () => void {
  return createRoot((dispose) => {
    const seen = new Map<
      string,
      {
        review: boolean;
        ready: boolean | null;
        landed: boolean;
        projectId: string;
        branch: string;
      }
    >();
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
                  attention: getTaskAttentionState(task.id),
                  gitKnown: isTaskGitStatusKnown(task.id),
                }
              : null,
          ),
        (tasks) => {
          const present = new Set<string>();
          for (const task of tasks) {
            if (!task) continue;
            present.add(task.id);
            const before = seen.get(task.id);
            const ready = taskReady(task, before?.ready);
            seen.set(task.id, {
              review: task.review,
              ready,
              landed: task.landed,
              projectId: task.projectId,
              branch: task.branch,
            });
            if (!before) continue;
            if (task.landed && !before.landed) advanceOnce(task, 'done');
            else if ((task.review && !before.review) || (ready === true && before.ready === false))
              advanceOnce(task, 'review');
          }
          for (const [id, task] of seen) {
            if (present.has(id)) continue;
            seen.delete(id);
            void completeCardOfClosedTask(task.projectId, task.branch);
          }
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
  return prefillKanbanAgentPrompt(project, buildKanbanPlanPrompt(goal)) !== null;
}

/**
 * Puts the prompt that clusters the cards into themes in the board agent's
 * prompt box: 'kept' when an unsent draft there was left alone instead.
 */
export function prefillKanbanClusterPrompt(project: Project): 'set' | 'kept' | null {
  return prefillKanbanAgentPrompt(project, buildKanbanClusterPrompt());
}

function prefillKanbanAgentPrompt(project: Project, prompt: string): 'set' | 'kept' | null {
  const task = ensureProjectAgentTask(kanbanAgentTaskId(project.id), project);
  if (!task) return null;
  if ((task.prefillPrompt ?? task.promptDraft ?? '').trim()) return 'kept';
  setPrefillPrompt(task.id, prompt);
  return 'set';
}

/** What adding GitHub items to a board did. */
export interface AddIssuesResult {
  added: number;
  /** The board did not exist and was created for them. */
  created: boolean;
  /** The column the cards went to. */
  column: string;
}

function addedMessage(total: number, { added, created, column }: AddIssuesResult): string {
  if (added === 0)
    return total === 1 ? 'Already on the plan' : `All ${total} are already on the plan`;
  const cards = `${added} ${added === 1 ? 'card' : 'cards'}`;
  const skipped = total - added;
  return (
    (created ? `Created KANBAN.md with ${cards} in ${column}` : `Added ${cards} to ${column}`) +
    (skipped ? `; ${skipped} already on the plan` : '')
  );
}

/**
 * Adds GitHub issues or PRs to the project's board as cards in the first
 * column, skipping any it already tracks and creating the board if the
 * project has none. Confirms the outcome, or reports the failure and
 * returns null.
 */
export async function addIssuesToBoard(
  projectId: string,
  items: readonly { title: string; url: string }[],
): Promise<AddIssuesResult | null> {
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) return null;
  try {
    let created = false;
    if ((await readKanbanFile(projectRoot)) === null) {
      try {
        await writeKanbanFile(projectRoot, DEFAULT_KANBAN_MARKDOWN, null);
        created = true;
      } catch (err) {
        // Losing the race to another writer is fine; the update below uses its board.
        if (!/changed on disk/.test(errMessage(err))) throw err;
      }
    }
    let added = 0;
    let column = '';
    await updateKanbanFile(projectRoot, (board) => {
      added = 0;
      const next = items.reduce((current, item) => {
        const updated = addIssueCard(current, item);
        if (updated !== current) added++;
        return updated;
      }, board);
      column = next.columns.find((c) => !isArchiveColumn(c.title))?.title ?? '';
      return next === board ? null : next;
    });
    // The same item picked twice is one card, not one skipped.
    const total = new Set(items.map((item) => item.url)).size;
    showNotification(addedMessage(total, { added, created, column }));
    return { added, created, column };
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
