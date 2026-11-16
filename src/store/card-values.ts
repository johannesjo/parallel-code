import { produce } from 'solid-js/store';
import { mergeRunValues } from '../lib/card-slots';
import type { CardDefinition, CardValues } from '../lib/cards';
import { setStore, store } from './core';
import type { Task } from './types';

// shortcut: prompt history keeps the newest 100, so tags stop at 100 — a turn counter on the task if long tasks need it
function currentTurn(task: Task): number {
  return Math.max(1, task.promptHistory?.length ?? 0);
}

/**
 * Stores one run's values for a card on a task, whoever filled it: add-up
 * item slots keep the earlier items and gain the run's new ones; every other
 * slot is replaced.
 */
export function storeCardRun(taskId: string, card: CardDefinition, run: CardValues): void {
  const task = store.tasks[taskId];
  if (!task) return;
  const values = mergeRunValues(
    card.slots,
    task.cards?.[card.id]?.values,
    run.values,
    currentTurn(task),
  );
  setStore(
    produce((s) => {
      const target = s.tasks[taskId];
      if (target) target.cards = { ...target.cards, [card.id]: { ...run, values } };
    }),
  );
}
