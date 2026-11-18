import { app, ipcMain, nativeImage, type BrowserWindow } from 'electron';
import { IPC } from './channels.js';
import { answerAgentPrompt, peekAgentPrompt } from './prompt-answer.js';
import { getAgentInputBlocker, getAgentPromptSnapshot, writeToAgent } from './pty.js';
import { assertInt, assertString } from './validate.js';

const MAX_LINES = 12;
const MAX_LINE_CHARS = 2000;

function screenOf(agentId: string, parsedSoFar = false): () => string | null {
  return () => getAgentPromptSnapshot(agentId, { parsedSoFar })?.text ?? null;
}

function assertLines(value: unknown, name: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_LINES ||
    !value.every((line) => typeof line === 'string' && line.length <= MAX_LINE_CHARS)
  )
    throw new Error(`${name} must be a short list of strings`);
}

/** Shows the Needs-you count on the dock (macOS), launcher (Linux) or taskbar (Windows). */
function setAttentionBadge(win: BrowserWindow, count: number, overlay: unknown): void {
  if (process.platform === 'win32') {
    if (win.isDestroyed()) return;
    // Windows has no badge count; the renderer draws the overlay icon.
    const image =
      count > 0 && typeof overlay === 'string' && overlay.startsWith('data:image/png;base64,')
        ? nativeImage.createFromDataURL(overlay)
        : null;
    win.setOverlayIcon(image, count > 0 ? `${count} waiting for you` : '');
    return;
  }
  app.setBadgeCount(count);
}

/** Peek at and answer an agent's choice dialog without opening its task, plus the waiting badge. */
export function registerAttentionHandlers(
  win: BrowserWindow,
  isAutomationWriteInFlight: (taskId: string) => boolean,
): void {
  ipcMain.handle(IPC.PeekAgentPrompt, (_e, args) => {
    assertString(args.agentId, 'agentId');
    // The screen as parsed so far: a peek must not wait on a busy agent's output.
    return peekAgentPrompt(screenOf(args.agentId, true));
  });
  ipcMain.handle(IPC.AnswerAgentPrompt, (_e, args) => {
    assertString(args.agentId, 'agentId');
    assertString(args.taskId, 'taskId');
    assertInt(args.n, 'n');
    assertLines(args.body, 'body');
    assertLines(args.labels, 'labels');
    // A peer prompt mid-paste or a coordinator write would take the key as text.
    if (getAgentInputBlocker(args.agentId) === 'busy' || isAutomationWriteInFlight(args.taskId))
      return false;
    return answerAgentPrompt({
      // Fully parsed only: a dialog still drawing, or already gone, must not be answered.
      screen: screenOf(args.agentId),
      write: (data) => writeToAgent(args.agentId, data),
      n: args.n,
      seen: { body: args.body, labels: args.labels },
    });
  });
  ipcMain.handle(IPC.SetAttentionBadge, (_e, args) => {
    assertInt(args.count, 'count');
    setAttentionBadge(win, Math.max(0, args.count), args.overlay);
  });
}
