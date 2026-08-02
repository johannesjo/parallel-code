import { store } from './core';
import { getTaskAttentionState, getTaskQuestionSince } from './taskStatus';

export interface NeedsInputEntry {
  taskId: string;
  /** When the question appeared (epoch ms), or null when unknown. */
  since: number | null;
}

/** Tasks currently blocked on a human answer, newest question first.
 *
 *  Collapsed tasks are included on purpose — a minimized task that starts
 *  asking is exactly the one that's easy to miss. Tasks with no recorded
 *  timestamp sink to the bottom in sidebar order (Array#sort is stable). */
export function computeNeedsInputTasks(): NeedsInputEntry[] {
  const entries: NeedsInputEntry[] = [];
  const seen = new Set<string>();

  for (const taskId of [...store.taskOrder, ...store.collapsedTaskOrder]) {
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    if (!store.tasks[taskId]) continue;
    if (getTaskAttentionState(taskId) !== 'needs_input') continue;
    entries.push({ taskId, since: getTaskQuestionSince(taskId) });
  }

  return entries.sort((a, b) => (b.since ?? 0) - (a.since ?? 0));
}
