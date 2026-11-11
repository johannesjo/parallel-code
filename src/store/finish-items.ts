/**
 * Loose ends the task's agent records through `finish_items_publish`, which the
 * Finish dialog sends back to it before merge.
 */
import { produce } from 'solid-js/store';
import { parseFinishItems } from '../../electron/shared/finish-items';
import { buildFinishItemsPrompt } from '../lib/finish-items';
import { store, setStore } from './core';
import { sendPrompt } from './tasks';

/**
 * Replaces the task's items with the agent's latest list; an empty list clears them.
 * Only worktree tasks have a Finish dialog, so other tasks reject the call
 * instead of storing items nobody would see.
 */
export function publishFinishItems(taskId: string, input: unknown): void {
  const items = parseFinishItems({ items: input });
  const task = Object.hasOwn(store.tasks, taskId) ? store.tasks[taskId] : undefined;
  if (!task || task.closingStatus) throw new Error('Task not available.');
  if (task.gitIsolation !== 'worktree')
    throw new Error('Only worktree tasks have a Finish dialog to show finish items.');
  // Replaced, not merged: a sent mark must not survive onto a new list.
  setStore(
    produce((s) => {
      const target = s.tasks[taskId];
      if (target)
        target.finishItems = items.length ? { items, publishedAt: Date.now() } : undefined;
    }),
  );
}

/** Sends the kept items to the task's main agent and marks the list as sent. */
export async function sendFinishItems(taskId: string, items: readonly string[]): Promise<void> {
  const task = store.tasks[taskId];
  const agentId = task?.agentIds[0];
  if (!agentId) throw new Error('The task has no agent.');
  const publishedAt = task.finishItems?.publishedAt;
  await sendPrompt(taskId, agentId, buildFinishItemsPrompt(items), { appPrompt: true });
  // A list the agent replaced while the prompt was in flight is new and stays unsent.
  if (publishedAt !== undefined && store.tasks[taskId]?.finishItems?.publishedAt === publishedAt)
    setStore('tasks', taskId, 'finishItems', 'sentAt', Date.now());
}
