import { store, setStore } from './core';
import type { ShellLayoutMode } from '../lib/shellLayout';

/** Pins one shell arrangement for every task; null returns to automatic. */
export function setShellLayoutOverride(mode: ShellLayoutMode | null): void {
  setStore('shellLayoutOverride', mode);
}

export function setTaskShellAutoLayout(taskId: string, mode: ShellLayoutMode): void {
  if (store.taskShellAutoLayout[taskId] === mode) return;
  setStore('taskShellAutoLayout', taskId, mode);
}

/** The arrangement a task's shells use: the pinned one, else the size-based pick. */
export function getTaskShellLayout(taskId: string): ShellLayoutMode {
  return store.shellLayoutOverride ?? store.taskShellAutoLayout[taskId] ?? 'row';
}
