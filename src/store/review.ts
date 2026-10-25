import { produce } from 'solid-js/store';
import {
  REVIEW_REASON_MAX,
  buildReworkPrompt,
  capReviewDismissals,
  type ReviewDismissal,
  type ReviewItem,
} from '../lib/review-summary';
import { setStore, store } from './core';
import { stageTaskPrompt } from './staged-prompt';

/** Sets a review risk aside, with an optional reason the user can add later. */
export function dismissReviewItem(taskId: string, item: ReviewItem, reason = ''): void {
  if (!store.tasks[taskId]) return;
  const entry: ReviewDismissal = { text: item.text, reason: reason.slice(0, REVIEW_REASON_MAX) };
  // Reworded items leave old ids behind, so the record is capped to the newest.
  const next = capReviewDismissals({ ...store.tasks[taskId].reviewDismissed, [item.id]: entry });
  setStore(
    produce((s) => {
      const task = s.tasks[taskId];
      if (task) task.reviewDismissed = next;
    }),
  );
}

export function setReviewDismissReason(taskId: string, id: string, reason: string): void {
  if (!store.tasks[taskId]?.reviewDismissed?.[id]) return;
  setStore('tasks', taskId, 'reviewDismissed', id, 'reason', reason.slice(0, REVIEW_REASON_MAX));
}

export function restoreReviewItem(taskId: string, id: string): void {
  const prev = store.tasks[taskId]?.reviewDismissed;
  if (!prev || !Object.hasOwn(prev, id)) return;
  // Store setters merge objects, so returning a copy without the key would keep it.
  setStore(
    produce((s) => {
      const task = s.tasks[taskId];
      if (!task?.reviewDismissed) return;
      delete task.reviewDismissed[id];
      if (Object.keys(task.reviewDismissed).length === 0) task.reviewDismissed = undefined;
    }),
  );
}

/** Every dismissal of a task, for prompts that should not raise them again. */
export function getReviewDismissals(taskId: string): ReviewDismissal[] {
  return Object.values(store.tasks[taskId]?.reviewDismissed ?? {});
}

/**
 * Puts the rework prompt in the task input for the user to read and send,
 * like the other prompts the finish dialog stages. Decisions it asks about
 * count as handled, as a correction sent from the brief card does.
 */
export function stageRework(taskId: string, items: ReviewItem[]): boolean {
  if (items.length === 0 || !store.tasks[taskId]) return false;
  stageTaskPrompt(taskId, buildReworkPrompt(items));
  const decisions = items.filter((entry) => entry.kind === 'decision');
  if (decisions.length > 0 && store.tasks[taskId].brief) {
    setStore(
      produce((s) => {
        const brief = s.tasks[taskId]?.brief;
        if (!brief) return;
        for (const entry of decisions) brief.decisions[entry.text] = 'sent';
      }),
    );
  }
  return true;
}
