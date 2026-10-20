import { store, setStore } from './core';
import { invoke } from '../lib/ipc';
import { warn } from '../lib/log';
import { IPC } from '../../electron/ipc/channels';
import type { MCPStatus } from './types';

let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 3_000;

export function hasAnyCoordinatorTask(): boolean {
  for (const id of store.taskOrder) {
    if (store.tasks[id]?.coordinatorMode) return true;
  }
  return false;
}

const MCP_STATUS_OFFLINE: MCPStatus = {
  running: false,
  port: null,
  coordinatorTaskId: null,
  mcpConfigPath: null,
};

export async function refreshMCPStatus(): Promise<void> {
  try {
    const result = await invoke<MCPStatus>(IPC.GetMCPStatus);
    setStore('mcpStatus', result);
  } catch (err) {
    warn('mcp', 'Could not read MCP status', { error: String(err) });
    setStore('mcpStatus', MCP_STATUS_OFFLINE);
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
  setStore('mcpStatus', MCP_STATUS_OFFLINE);
}
