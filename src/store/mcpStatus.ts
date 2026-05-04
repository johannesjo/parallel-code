import { store, setStore } from './core';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';

let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 3_000;

export function hasAnyCoordinatorTask(): boolean {
  for (const id of store.taskOrder) {
    if (store.tasks[id]?.coordinatorMode) return true;
  }
  return false;
}

export async function refreshMCPStatus(): Promise<void> {
  try {
    const result = await invoke<{ mcpRunning: boolean; remoteRunning: boolean }>(IPC.GetMCPStatus);
    setStore('mcpStatus', result);
  } catch {
    setStore('mcpStatus', { mcpRunning: false, remoteRunning: false });
  }
}

export function startMCPStatusPolling(): void {
  if (pollTimer) return;
  refreshMCPStatus();
  pollTimer = setInterval(refreshMCPStatus, POLL_INTERVAL_MS);
}

export function stopMCPStatusPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  setStore('mcpStatus', { mcpRunning: false, remoteRunning: false });
}
