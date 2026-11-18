import { store, setStore } from './core';
import { PORT_ENV_NAME, isPortBase, pickPortBase } from '../lib/task-ports';

/**
 * The task's port block, assigned on first use and persisted with the task so
 * a restarted server comes back on the same address. A closed task leaves the
 * store, which frees its block for the next task.
 */
export function ensureTaskPortBase(taskId: string): number | undefined {
  const task = store.tasks[taskId];
  if (!task) return undefined;
  if (task.portBase !== undefined) return task.portBase;
  const taken = Object.values(store.tasks)
    .map((t) => t?.portBase)
    .filter(isPortBase);
  const base = pickPortBase(taken);
  if (base !== undefined) setStore('tasks', taskId, 'portBase', base);
  return base;
}

/** `PARALLEL_CODE_PORT` for a task's terminals, or nothing outside a task. */
export function taskPortEnv(taskId: string): Record<string, string> {
  const base = ensureTaskPortBase(taskId);
  return base === undefined ? {} : { [PORT_ENV_NAME]: String(base) };
}
