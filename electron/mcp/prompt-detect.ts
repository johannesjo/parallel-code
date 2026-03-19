// Shared prompt-detection helpers used by both the renderer (taskStatus.ts)
// and the main-process orchestrator (orchestrator.ts).

/** Strip ANSI escape sequences (CSI, OSC, and single-char escapes) from terminal output. */
export function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g,
    '',
  );
}

/**
 * Patterns that indicate the agent is waiting for user input (i.e. idle).
 * Each regex is tested against the last non-empty line of stripped output.
 */
export const PROMPT_PATTERNS: RegExp[] = [
  /❯\s*$/, // Claude Code prompt
  /(?:^|\s)\$\s*$/, // bash/zsh dollar prompt (preceded by whitespace or BOL)
  /(?:^|\s)%\s*$/, // zsh percent prompt
  /(?:^|\s)#\s*$/, // root prompt
  /\[Y\/n\]\s*$/i, // Y/n confirmation
  /\[y\/N\]\s*$/i, // y/N confirmation
];

/**
 * Patterns for known agent main input prompts (ready for a new task).
 * Tested against the stripped data chunk (not a single line), because TUI
 * apps like Claude Code use cursor positioning instead of newlines.
 */
export const AGENT_READY_TAIL_PATTERNS: RegExp[] = [
  /❯/, // Claude Code
  /›/, // Codex CLI
];

/** Check stripped output for known agent prompt characters.
 *  Only checks the tail of the chunk — the agent's main prompt renders as
 *  the last visible element, while TUI selection UIs place ❯ earlier in
 *  the render followed by option text and other choices. */
export function chunkContainsAgentPrompt(stripped: string): boolean {
  if (stripped.length === 0) return false;
  const tail = stripped.slice(-50);
  return AGENT_READY_TAIL_PATTERNS.some((re) => re.test(tail));
}
