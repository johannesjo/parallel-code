/**
 * Writes to the workspace's interactive agent the way the task prompt box
 * does: focus-in, the text as one bracketed paste, then Enter after the TUI
 * had time to take the paste.
 */
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { pasteDelayMs } from '../store/tasks';
import { setRailTab, workspaceUi } from './workspace-ui';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const FOCUS_IN = '\x1b[I';
/** How long to wait for the terminal to come up when it was not mounted yet. */
const SPAWN_WAIT_MS = 15_000;
const POLL_MS = 100;
/** A CLI that just started needs a moment before it takes input. */
const FRESH_START_DELAY_MS = 2_500;

/** The pty id of a project's interactive agent; stable so the session can be
 *  re-attached after the workspace was closed and reopened. */
export function documentAgentPtyId(projectId: string): string {
  return `doc-agent-${projectId}`;
}

/** The task id the pty is filed under; no task owns it. */
export function documentAgentTaskId(projectId: string): string {
  return `doc-agent-${projectId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves once the terminal reports a live process, or throws after a wait. */
async function waitForAgent(): Promise<void> {
  const wasRunning = workspaceUi.agentRunning;
  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (!workspaceUi.agentRunning) {
    if (Date.now() > deadline) throw new Error('The agent terminal did not start.');
    await sleep(POLL_MS);
  }
  // shortcut: a fixed settle delay for a fresh CLI — the task flow watches
  // for a stable prompt instead; adopt that if prompts get swallowed.
  if (!wasRunning) await sleep(FRESH_START_DELAY_MS);
}

/** Types `text` into the interactive agent, bringing its tab up first. */
export async function sendToDocumentAgent(ptyId: string, text: string): Promise<void> {
  setRailTab('agent');
  await waitForAgent();
  await invoke(IPC.WriteToAgent, { agentId: ptyId, data: FOCUS_IN });
  await invoke(IPC.WriteToAgent, {
    agentId: ptyId,
    data: `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`,
  });
  await sleep(pasteDelayMs(text));
  await invoke(IPC.WriteToAgent, { agentId: ptyId, data: '\r' });
}
