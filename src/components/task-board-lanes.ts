import { isHiddenAgentTaskId } from '../documents/task-id';
import { store } from '../store/core';
import { isTaskBackgrounded } from '../store/background-tasks';
import { getPrBabysit, isPrBabysitStuck } from '../store/pr-babysit';
import { getPrChecks, isPrReadyToMerge } from '../store/pr-checks-state';
import { getProject } from '../store/projects';
import { sortByProjectGroup } from '../store/sidebar-order';
import { matchesTaskProjectFilter } from '../store/task-project-filter';
import { getTaskOpenQuestion } from '../store/taskStatus';
import type { Task } from '../store/types';
import { cardTaskState, finishCheckLabel, type CardTaskState } from './board/task-state';
import { holdWorking } from './task-board-hold';

export type BoardLaneId = 'needs' | 'working' | 'stopped' | 'pr' | 'ready' | 'snoozed';

export interface BoardLane {
  id: BoardLaneId;
  title: string;
  tasks: Task[];
}

// Left to right. Stopped sits next to Needs you so everything waiting on you
// is together; Working and In pull request need nothing from you yet. Ready to
// merge follows the pull requests it graduates from.
const LANE_TITLES: Record<BoardLaneId, string> = {
  needs: 'Needs you',
  stopped: 'Stopped',
  working: 'Working',
  pr: 'In pull request',
  ready: 'Ready to merge',
  snoozed: 'Snoozed & minimized',
};

/** A task's state as the board shows it, with short pauses in work smoothed over.
 *  A closing task's agents are stopped on purpose, so their exit is no failure. */
export function boardTaskState(task: Task): CardTaskState {
  if (task.closingStatus) return 'idle';
  return holdWorking(task.id, cardTaskState(task));
}

/** The Finish check the card names, while no agent works or asks; '' otherwise.
 *  A closing task's checks end with it, so they are no work in progress. */
export function boardCheckLabel(task: Task): string {
  if (task.closingStatus) return '';
  const state = boardTaskState(task);
  if (state === 'active' || state === 'needs_input' || state === 'error') return '';
  return finishCheckLabel(task);
}

/** Where a task sits on the board: the first of these checks that claims it. */
export function boardLaneOf(task: Task): BoardLaneId {
  // A close that failed leaves a worktree behind until someone retries.
  if (task.closingStatus === 'error') return 'needs';
  // Snoozed tasks wake on their own when they need attention.
  if (isTaskBackgrounded(task.id)) return 'snoozed';
  const state = boardTaskState(task);
  if (state === 'needs_input' || state === 'error') return 'needs';
  // A review or check started from Finish is still work in progress: the
  // task needs you again once it has a result.
  const checking = boardCheckLabel(task) !== '';
  if (state === 'review' && !checking) return 'needs';
  // Minimized tasks never wake, so they join the snoozed ones only while
  // nothing needs you; otherwise a question would wait unseen in the rail.
  if (task.collapsed) return 'snoozed';
  if (state === 'active' || checking) return 'working';
  if (task.prUrl) return pullRequestLane(task.id);
  // Ready vs idle hinges on whether the agent committed, not on what you do
  // next, so they share a lane and the card's label tells them apart.
  return 'stopped';
}

/** A pull request waits on you when GitHub says it cannot merge as it is, or
 *  when it can; otherwise on CI or reviewers. Babysit sends CI failures back to
 *  the agent, so those wait on it until Babysit gives up or gets stuck. */
function pullRequestLane(taskId: string): BoardLaneId {
  const checks = getPrChecks(taskId);
  if (!checks || checks.merged) return 'pr';
  if (isPrReadyToMerge(checks)) return 'ready';
  if (checks.mergeable === 'CONFLICTING' || checks.reviewDecision === 'CHANGES_REQUESTED')
    return 'needs';
  if (checks.overall === 'failure' && (!getPrBabysit(taskId) || isPrBabysitStuck(taskId)))
    return 'needs';
  return 'pr';
}

function matchesQuery(task: Task, query: string): boolean {
  if (!query) return true;
  const haystack = [task.name, task.branchName, getProject(task.projectId)?.name]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

/** Open tasks in sidebar order (grouped by project), honouring the sidebar's project filter. */
function openTasks(): Task[] {
  return sortByProjectGroup([...new Set([...store.taskOrder, ...store.collapsedTaskOrder])])
    .filter((id) => !isHiddenAgentTaskId(id) && matchesTaskProjectFilter(id))
    .map((id) => store.tasks[id])
    .filter((task): task is Task => task !== undefined);
}

/** The board's tasks, minimized ones included, matching the filter. */
export function boardTasks(query: string): Task[] {
  const needle = query.trim().toLowerCase();
  return openTasks().filter((task) => matchesQuery(task, needle));
}

/** The longest-waiting question first; failures and reviews follow in sidebar order. */
function byLongestWait(tasks: Task[]): Task[] {
  const since = (task: Task) => getTaskOpenQuestion(task.id)?.since ?? Number.MAX_SAFE_INTEGER;
  return [...tasks].sort((a, b) => since(a) - since(b));
}

/** Committed, clean work first; the rest keeps sidebar order. */
function readyFirst(tasks: Task[]): Task[] {
  const rank = (task: Task) => (boardTaskState(task) === 'ready' ? 0 : 1);
  return [...tasks].sort((a, b) => rank(a) - rank(b));
}

/**
 * Keeps each coordinator's subtasks together, right after it when it shares
 * the lane. A family sits where its first member did, so an urgent subtask
 * still lifts it to the top of Needs you.
 */
export function groupSubtasks(tasks: Task[]): Task[] {
  const families = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = task.coordinatedBy ?? task.id;
    const family = families.get(key) ?? [];
    if (task.id === key) family.unshift(task);
    else family.push(task);
    families.set(key, family);
  }
  return [...families.values()].flat();
}

/**
 * The coordinator to name above a lane's `index`th task: set where a block of
 * its subtasks starts without it directly above, so each block names it once.
 */
export function headingParentAt(tasks: Task[], index: number): string | undefined {
  const parentId = tasks[index]?.coordinatedBy;
  const above = tasks[index - 1];
  if (!parentId || above?.id === parentId || above?.coordinatedBy === parentId) return undefined;
  return parentId;
}

export function boardLanes(tasks: Task[]): BoardLane[] {
  const lanes = (Object.keys(LANE_TITLES) as BoardLaneId[]).map((id) => ({
    id,
    title: LANE_TITLES[id],
    tasks: [] as Task[],
  }));
  for (const task of tasks) lanes.find((lane) => lane.id === boardLaneOf(task))?.tasks.push(task);
  const needs = lanes[0];
  if (needs) needs.tasks = byLongestWait(needs.tasks);
  const stopped = lanes.find((lane) => lane.id === 'stopped');
  if (stopped) stopped.tasks = readyFirst(stopped.tasks);
  for (const lane of lanes) lane.tasks = groupSubtasks(lane.tasks);
  return lanes;
}
