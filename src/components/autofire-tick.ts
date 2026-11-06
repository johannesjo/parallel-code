import type { StagedNotification } from '../store/types';

const PROMPT_MARKER_SCAN_CHARS = 500;

export type AutoFireTickResult =
  | { outcome: 'too-soon' }
  | { outcome: 'paused' }
  | { outcome: 'waiting' }
  | { outcome: 'no-prompt'; newMissCount: number }
  | { outcome: 'fire' };

/**
 * Pure decision function for a single autofire interval tick.
 * Returns what the tick should do without executing any side effects.
 * Exported for unit testing.
 */
export function processAutoFireTick(params: {
  staged: StagedNotification;
  now: number;
  controlledBy: 'coordinator' | 'human' | undefined;
  allowPromptlessGrace?: boolean;
  questionActive: boolean;
  /** The screen shows a numbered selection menu that Enter would answer. */
  menuBlocking?: boolean;
  promptDraftActive?: boolean;
  terminalInputPending?: boolean;
  userActivityHoldUntil?: number;
  tail: string;
  currentMissCount: number;
}): AutoFireTickResult {
  if (params.staged.autoFireAt - params.now > 0) {
    return { outcome: 'too-soon' };
  }

  if (params.promptDraftActive || params.terminalInputPending) {
    return { outcome: 'waiting' };
  }

  if ((params.userActivityHoldUntil ?? 0) > params.now) {
    return { outcome: 'waiting' };
  }

  // A question/dialog is active — the ❯ visible in the TUI is a selection
  // cursor, not the agent prompt. Pause to avoid sending into the dialog.
  if (params.questionActive || params.menuBlocking) {
    return { outcome: 'paused' };
  }

  // User has manually edited the prompt — suppress autofire indefinitely until
  // they press Enter themselves.
  if (params.staged.userEdited) {
    return { outcome: 'paused' };
  }

  // In coordinator-controlled mode the coordinator may be in a long tool-call
  // loop and never show a ❯ prompt marker. After a generous grace period past
  // autoFireAt, fire anyway — the PTY buffers the input and Claude reads it
  // between tool calls. The grace period gives questionActive time to detect
  // interactive dialogs before we bypass the prompt-marker check.
  const COORDINATOR_PROMPTLESS_GRACE_MS = 120_000;
  if (params.allowPromptlessGrace ?? params.controlledBy === 'coordinator') {
    if (params.now - params.staged.autoFireAt >= COORDINATOR_PROMPTLESS_GRACE_MS) {
      return { outcome: 'fire' };
    }

    const tailSnippet = params.tail.slice(-PROMPT_MARKER_SCAN_CHARS);
    const hasPrompt = /[❯›]/.test(tailSnippet);
    return hasPrompt ? { outcome: 'fire' } : { outcome: 'too-soon' };
  }

  const tailSnippet = params.tail.slice(-PROMPT_MARKER_SCAN_CHARS);
  const hasPrompt = /[❯›]/.test(tailSnippet);
  if (!hasPrompt) {
    return { outcome: 'no-prompt', newMissCount: params.currentMissCount + 1 };
  }

  return { outcome: 'fire' };
}
