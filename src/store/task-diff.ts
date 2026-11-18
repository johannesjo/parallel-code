/**
 * Reading a task's branch diff and keeping its code fingerprint, which ratings
 * and other reports are compared against to tell when they went out of date.
 */

import { produce } from 'solid-js/store';
import { getTaskDiffBaseBranch, loadTaskDiff } from '../lib/load-task-diff';
import { errMessage, warn as logWarn } from '../lib/log';
import { diffFingerprint } from '../lib/diff-excerpt';
import { diffStats, type TaskFacts } from '../lib/app-facts';
import { store, setStore } from './core';
import { getProjectPath } from './projects';
import type { Task } from './types';

export function isLiveTask(task: Task | undefined): task is Task {
  return !!task && !task.closingStatus && !!task.worktreePath;
}

/** The branch diff, '' when the task has no git, or undefined when it could not be read. */
export async function readTaskDiff(task: Task): Promise<string | undefined> {
  if (task.gitIsolation === 'none') return '';
  try {
    const { rawDiff } = await loadTaskDiff({
      worktreePath: task.worktreePath,
      projectRoot: getProjectPath(task.projectId),
      branchName: task.branchName,
      baseBranch: getTaskDiffBaseBranch(task.gitIsolation, task.baseBranch),
    });
    return rawDiff;
  } catch (error) {
    logWarn('taskDiff', 'Could not read the task diff', { error: errMessage(error) });
    return undefined;
  }
}

/** Prompts sent after `since`; with no `since`, the prompt the task started with. */
export function promptsSince(task: Task, since: number): string[] {
  const history = task.promptHistory ?? [];
  const recent = history.filter((entry) => (entry.sentAt ?? 0) > since).map((e) => e.text);
  if (recent.length || since > 0) return recent;
  const first = task.savedInitialPrompt || history.at(-1)?.text || task.lastPrompt;
  return first ? [first] : [];
}

/** Records the newest code fingerprint seen, which ratings are compared against. */
export function noteCodeFingerprint(taskId: string, fingerprint: string, at: number): void {
  const known = store.tasks[taskId]?.codeFingerprint;
  if (known && known.at >= at) return;
  setStore('tasks', taskId, 'codeFingerprint', { fingerprint, at });
}

/**
 * Reads the diff to tell whether a rating is still current. The fingerprint
 * tracker does this after every turn while the task is tracked; the Finish review also
 * calls it, for changes made between turns. Resolves with the diff it read,
 * so model cards can share it; undefined when it could not be read.
 */
export async function refreshCodeFingerprint(taskId: string): Promise<string | undefined> {
  const task = store.tasks[taskId];
  if (!isLiveTask(task)) return undefined;
  const at = Date.now();
  const rawDiff = await readTaskDiff(task);
  if (rawDiff === undefined) return undefined;
  noteCodeFingerprint(taskId, diffFingerprint(rawDiff), at);
  noteTaskFacts(taskId, { diff: { ...diffStats(rawDiff), at } });
  return rawDiff;
}

/** Merges newly gathered app facts into the task's; each carries its own read time. */
export function noteTaskFacts(taskId: string, update: TaskFacts): void {
  setStore(
    produce((s) => {
      const target = s.tasks[taskId];
      if (target) target.facts = { ...target.facts, ...update };
    }),
  );
}

/**
 * Reads the diff after something was published and hands over its
 * fingerprint, so later work can make it out of date. Unread code cannot be
 * compared later, so nothing is handed over then.
 */
export function fingerprintAfterPublish(task: Task, apply: (fingerprint: string) => void): void {
  void readTaskDiff(task).then((rawDiff) => {
    if (rawDiff !== undefined) apply(diffFingerprint(rawDiff));
  });
}

/** The task a publish targets, unless it is gone or closing. */
export function publishTarget(taskId: string): Task {
  const task = store.tasks[taskId];
  if (!Object.hasOwn(store.tasks, taskId) || !task || task.closingStatus)
    throw new Error('Task not available.');
  return task;
}
