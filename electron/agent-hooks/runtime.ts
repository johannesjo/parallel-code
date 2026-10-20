import { type BrowserWindow } from 'electron';
import path from 'path';
import { IPC } from '../ipc/channels.js';
import { getUserDataDir } from '../user-data-dir.js';
import { setAgentHookRuntime } from '../ipc/pty.js';
import { error as logError, info as logInfo } from '../log.js';
import { recordClaudeStatusLine } from '../ipc/claude-usage.js';
import { emitAgentHookEvent } from './events.js';
import { startAgentHookServer, type AgentHookServer } from './server.js';
import { observeAgentHook, onAgentActivityObservation } from './observations.js';
import type { AgentHookEventPayload } from './status.js';

let server: AgentHookServer | null = null;
let stopObservations: (() => void) | undefined;

/**
 * Brings up the loopback hook receiver and hands its env/settings to the PTY
 * layer so every Claude Code launch from here on reports its own status.
 * Failure is logged and otherwise ignored: the PTY heuristics keep working.
 */
export async function startAgentHookRuntime(getWindow: () => BrowserWindow | null): Promise<void> {
  // Per-instance, not raw userData: this directory holds endpoint.env (loopback
  // port + bearer token), written only at startup, so sharing it between a dev
  // run and an installed build hands every agent's hook events to whichever
  // instance started last.
  const dir = path.join(getUserDataDir(), 'agent-hooks');
  stopObservations?.();
  stopObservations = onAgentActivityObservation((observation) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.AgentHookEvent, observation);
  });
  // Resolved per event: the server starts before the window exists so that no
  // Claude launch can race it, and the window may be recreated later.
  const forward = (event: AgentHookEventPayload): void => {
    observeAgentHook(event);
    // Main-process consumers (the MCP coordinator) get the event regardless of
    // window state — a coordinated sub-task keeps running with no window.
    emitAgentHookEvent(event);
  };
  // The usage store keeps the numbers; the renderer is only told they moved and re-reads them.
  const onUsage = (payload: unknown): void => {
    if (!recordClaudeStatusLine(payload)) return;
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.ClaudeUsageChanged);
  };
  try {
    server = await startAgentHookServer({ dir, onEvent: forward, onUsage });
  } catch (err) {
    logError('agent-hooks', 'failed to start hook server; using PTY heuristics only', err);
    return;
  }
  setAgentHookRuntime({
    claudeSettingsPath: server.claudeSettingsPath,
    buildPtyEnv: server.buildPtyEnv,
  });
  logInfo('agent-hooks', 'hook server listening', { port: server.port, dir });
}

export function stopAgentHookRuntime(): void {
  setAgentHookRuntime(null);
  stopObservations?.();
  stopObservations = undefined;
  const current = server;
  server = null;
  current?.close().catch((err: unknown) => {
    logError('agent-hooks', 'failed to close hook server', err);
  });
}
