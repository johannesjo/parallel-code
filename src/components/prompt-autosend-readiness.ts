import { normalizeCurrentFrame } from '../store/taskStatus';
import {
  AGENT_READY_TAIL_CHARS,
  cursorRowsToLines,
  showsSelectionMenu,
  stripAnsi,
} from '../../electron/mcp/prompt-detect';

const STARTUP_BLOCKING_PATTERNS: RegExp[] = [
  /\bmodel:\s*loading\b/i,
  /\bBooting\s+MCP\s+servers?\b/i,
  /\bStarting\s+MCP\s+servers?\b/i,
];

export function isStartupBlockingAutoSend(tail: string): boolean {
  const frame = normalizeCurrentFrame(tail);
  // An empty frame means a screen-clear or cursor-home was just emitted but
  // the new frame content hasn't arrived yet (mid-redraw).  Treat this as
  // blocking so we don't start stability checks against an empty snapshot
  // that will immediately fail once real content fills in.
  if (!frame) return true;
  return STARTUP_BLOCKING_PATTERNS.some((re) => re.test(frame));
}

/**
 * True while the terminal shows a numbered selection menu, such as Codex's
 * "Update available" screen (#336) or a login or permission picker. The
 * auto-send writes Enter, which would pick the highlighted option. Kept apart
 * from `isStartupBlockingAutoSend`, which also gates handing a coordinated
 * task's question to the user: a menu is exactly such a question.
 */
export function isMenuBlockingAutoSend(tail: string): boolean {
  // Raw tails carry several escape bytes per visible character; take enough
  // to cover the visible window the readiness check reads.
  const raw = tail.slice(-AGENT_READY_TAIL_CHARS * 4);
  return showsSelectionMenu(stripAnsi(cursorRowsToLines(raw)).slice(-AGENT_READY_TAIL_CHARS));
}

/** Everything on screen that must hold an automatic prompt send. */
export function isScreenBlockingAutoSend(tail: string): boolean {
  return isStartupBlockingAutoSend(tail) || isMenuBlockingAutoSend(tail);
}

export function shouldAbortInitialPromptAfterTimeout(params: {
  elapsedMs: number;
  maxWaitMs: number;
  coordinatedBy: string | undefined;
  tail: string;
}): boolean {
  if (params.elapsedMs <= params.maxWaitMs) return false;
  if (params.coordinatedBy) return false;
  return Boolean(normalizeCurrentFrame(params.tail));
}
