import { createEffect, createRoot } from 'solid-js';
import { produce } from 'solid-js/store';
import { modelToRun } from '../lib/ask-code-model';
import { startModelRequest } from '../lib/model-request';
import { errMessage, info as logInfo, warn as logWarn } from '../lib/log';
import { diffFingerprint } from '../lib/task-brief';
import {
  buildTaskReviewPrompt,
  parseTaskReviewResponse,
  type ReviewCheckResult,
  withReviewEffort,
  type ReviewModelSettings,
} from '../lib/task-review';
import { store, setStore } from './core';
import { setPendingAction } from './focus';
import { isLandedTaskState } from './landing';
import { setActiveTask } from './navigation';
import { showNotification, NOTIFICATION_ERROR_MS } from './notification';
import { getReviewDismissals } from './review';
import { isLiveTask, noteCodeFingerprint, promptsSince, readTaskDiff } from './task-brief';
import { uncollapseTask } from './tasks';
import type { Task } from './types';

const inFlight = new Map<string, () => void>();
/** Tasks whose latest review finished and has not been shown yet. */
const unseen = new Set<string>();

/**
 * Whether a review finished since the task's review was last shown; asking
 * counts as showing it. The user asked for that review, so it opens unfolded.
 */
export function takeUnseenReview(taskId: string): boolean {
  return unseen.delete(taskId);
}

/** Finish opens only on a worktree task that has not landed; see TaskPanel. */
function canFinish(task: Task | undefined): task is Task {
  return task?.gitIsolation === 'worktree' && !isLandedTaskState(task.landingState);
}

/** Brings a task forward with its Finish dialog open, where the review is read. */
export function openTaskReview(taskId: string): void {
  const task = store.tasks[taskId];
  // Gone or landed since the notice went up: no panel would take the request.
  if (!canFinish(task)) return;
  if (task.collapsed) uncollapseTask(taskId);
  setActiveTask(taskId);
  setPendingAction({ type: 'finish', taskId });
}

/** Replaces the status whole; a store merge would carry fields over from the last one. */
function setReviewStatus(taskId: string, status: Task['reviewStatus']): void {
  setStore(
    produce((s) => {
      const target = s.tasks[taskId];
      if (target) target.reviewStatus = status;
    }),
  );
}

/** The model a task's reviews run on: its own pick, else the one in Settings › Review. */
export function taskReviewModel(taskId: string): ReviewModelSettings {
  return store.tasks[taskId]?.reviewModel ?? store.reviewModel;
}

/** Picks the reviewer for one task; other tasks keep the Settings › Review choice. */
export function setTaskReviewModel(taskId: string, model: ReviewModelSettings): void {
  setStore(
    produce((s) => {
      const target = s.tasks[taskId];
      if (target) target.reviewModel = { ...model };
    }),
  );
}

/** The model a task's reviews run on, as the user would name it. */
export function reviewerName(taskId: string): string {
  const { provider, model } = taskReviewModel(taskId);
  return modelToRun(provider, model ?? '') || (provider === 'codex' ? 'Codex' : 'Claude');
}

/**
 * Rates a task's work with a model call of its own, apart from the task's
 * agent, which would otherwise grade itself. It reads every prompt the user
 * sent, the branch diff and, once they end, the results of the checks started
 * with it. The review runs in the background: closing the
 * Finish dialog leaves it running, closing the task stops it. One review per
 * task at a time; a second start while one runs does nothing.
 */
export async function startTaskReview(
  taskId: string,
  checks?: Promise<ReviewCheckResult[]>,
): Promise<void> {
  const task = store.tasks[taskId];
  if (!isLiveTask(task) || inFlight.has(taskId)) return;
  let cancelled = false;
  let cancelRequest = () => {};
  // Checks can run for minutes, so a cancel must not wait for them to end.
  let stopWaiting = () => {};
  const stopped = new Promise<undefined>((resolve) => (stopWaiting = () => resolve(undefined)));
  const cancel = () => {
    cancelled = true;
    stopWaiting();
    cancelRequest();
  };
  inFlight.set(taskId, cancel);
  // The rating covers the code as it is now, not as it is when the model answers.
  const startedAt = Date.now();
  setReviewStatus(taskId, { state: 'running', startedAt });
  // A closed task's rating would never be read, so the call stops rather than run on.
  const stopWatching = createRoot((dispose) => {
    createEffect(() => {
      if (!isLiveTask(store.tasks[taskId])) cancel();
    });
    return dispose;
  });
  try {
    const rawDiff = await readTaskDiff(task);
    if (cancelled) return;
    const fingerprint = rawDiff === undefined ? undefined : diffFingerprint(rawDiff);
    if (fingerprint !== undefined) noteCodeFingerprint(taskId, fingerprint, startedAt);
    const checkResults = await Promise.race([checks, stopped]);
    if (cancelled) return;
    // The review's own level, not the Q&A default: it must read before it reports.
    const settings = withReviewEffort(taskReviewModel(taskId));
    const model = modelToRun(settings.provider, settings.model ?? '');
    const reviewer = reviewerName(taskId);
    const request = startModelRequest({
      prompt: buildTaskReviewPrompt({
        taskName: task.name,
        prompts: promptsSince(task, 0),
        rawDiff,
        dismissed: getReviewDismissals(taskId),
        guidance: store.reviewGuidance,
        ...(checkResults && { checks: checkResults }),
      }),
      cwd: task.worktreePath,
      settings: { ...settings, model: model || undefined },
      agentEnvFiles: store.agentEnvFiles,
      projectId: task.projectId,
      purpose: 'review',
    });
    cancelRequest = request.cancel;
    const response = await request.result;
    if (cancelled || !isLiveTask(store.tasks[taskId])) return;
    const payload = parseTaskReviewResponse(response, `Review by ${reviewer}`);
    // Before the status clears: an open review section takes the flag as the run ends.
    unseen.add(taskId);
    // Replaced, not merged: a field the new rating leaves out must not survive from the old one.
    // Dated when it started, so code changed while the model read counts as newer.
    setStore(
      produce((s) => {
        const target = s.tasks[taskId];
        if (!target) return;
        target.confidence = {
          ...payload,
          publishedAt: startedAt,
          ...(fingerprint && { fingerprint }),
        };
        target.reviewStatus = undefined;
      }),
    );
    logInfo('taskReview', 'Review finished', { taskId, durationMs: Date.now() - startedAt });
    // The review is read in the Finish dialog; where that is off or cannot open, or a
    // section on screen already took the flag, a plain notice says it is done.
    showNotification(`The review of “${task.name}” is ready.`, {
      durationMs: NOTIFICATION_ERROR_MS,
      ...(store.finishReview &&
        canFinish(store.tasks[taskId]) &&
        unseen.has(taskId) && {
          action: {
            // Uncollapsing starts the task's agents, so the label says so. A getter,
            // so a task collapsed while the notice is up relabels it.
            get label() {
              return store.tasks[taskId]?.collapsed ? 'Resume and open review' : 'Open review';
            },
            run: () => openTaskReview(taskId),
          },
        }),
    });
  } catch (error) {
    if (cancelled || !store.tasks[taskId]) return;
    const message = errMessage(error);
    logWarn('taskReview', 'Review failed', { taskId, error: message });
    setReviewStatus(taskId, { state: 'failed', message });
    showNotification(`The review of “${task.name}” failed: ${message}`);
  } finally {
    stopWatching();
    if (inFlight.get(taskId) === cancel) inFlight.delete(taskId);
    // Every exit (cancel, a task that closed meanwhile) must clear the running state.
    if (store.tasks[taskId]?.reviewStatus?.state === 'running') setReviewStatus(taskId, undefined);
  }
}

/** Stops a task's running review; its last rating stays. */
export function cancelTaskReview(taskId: string): void {
  inFlight.get(taskId)?.();
}
