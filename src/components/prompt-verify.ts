import { stripAnsi } from '../store/taskStatus';

// TUIs wrap, indent and re-break the echoed prompt, so only the visible
// characters are compared, not the whitespace between them.
const squash = (text: string): string => stripAnsi(text).replace(/\s+/g, '');

// Claude Code (`[Pasted text #1 +120 lines]`) and Codex (`[Pasted Content 6892 chars]`)
// show long pastes as a placeholder, so the prompt text itself never appears.
// Matched on squashed text, as Claude Code may draw its spaces as cursor moves.
const PASTE_PLACEHOLDER_RE = /\[Pasted(?:text#\d+|Content\d+chars)/g;

function hasNewPastePlaceholder(tail: string, before: ReadonlySet<string>): boolean {
  return (squash(tail).match(PASTE_PLACEHOLDER_RE) ?? []).some((p) => !before.has(p));
}

/**
 * Polls until the opening snippet of `prompt` appears in `getTail(agentId)`,
 * or a paste placeholder that was not on screen before the send appears,
 * returning true on success and false on timeout or abort.
 *
 * Returns false immediately when the signal is already aborted.  Otherwise
 * returns true immediately when:
 * - prompt is empty (nothing to verify)
 * - the snippet was already in preSendTail (pre-existing content, not a new echo)
 *
 * The snippet is the first 40 visible characters of the prompt (ANSI codes and
 * whitespace removed) — enough to uniquely identify it without risking false
 * matches on short fragments.
 */
export async function pollUntilPromptAppearsInOutput(
  agentId: string,
  prompt: string,
  preSendTail: string,
  signal: AbortSignal,
  getTail: (agentId: string) => string,
  deadlineMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  // Check abort before the early-success paths: a superseded send must not be
  // reported as verified just because the prompt was empty or already visible.
  if (signal.aborted) return false;
  const snippet = squash(prompt).slice(0, 40);
  if (!snippet) return true;
  // Already visible before we sent — skip verification to avoid false positives.
  const squashedPreSendTail = squash(preSendTail);
  if (squashedPreSendTail.includes(snippet)) return true;
  const placeholdersBefore = new Set(squashedPreSendTail.match(PASTE_PLACEHOLDER_RE));
  const appeared = (): boolean => {
    const tail = getTail(agentId);
    return squash(tail).includes(snippet) || hasNewPastePlaceholder(tail, placeholdersBefore);
  };

  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (signal.aborted) return false;
    if (appeared()) return true;
    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
  }
  // Final check: the echo may have arrived during the last sleep or right at the
  // deadline boundary, after the loop's last in-loop check.
  return !signal.aborted && appeared();
}
