// Shared prompt-detection helpers used by both the renderer (taskStatus.ts)
// and the main-process coordinator (coordinator.ts).

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
  /›\s*$/, // Codex CLI prompt
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
  /^\s*❯\s*$/, // Claude Code
  /^\s*❯\s*Try\s+["“]/i, // Claude Code empty prompt with rotating suggestion
  /^\s*--\s*INSERT\s*--(?:$|\s|[^\w].*$)/i, // Claude Code vim-style input mode
  /^\s*›\s*$/, // Codex CLI
  // Codex redraws can lose CSI escape introducers when output chunks split an
  // escape sequence. stripAnsi then leaves `q` separators and cursor-position
  // fragments, collapsing the input placeholder and footer onto one line.
  /(?:^|\s|q)›[^\r\n›]*?gpt-[\w.-]+\s+\w+\s+·\s+~?\//i,
  /^\s*>\s*(?:Type your message|$)/i, // Gemini CLI
];

export const AGENT_READY_TAIL_CHARS = 1000;
const AGENT_BLOCKER_TAIL_CHARS = 500;

export type AgentPromptReadinessReason = 'ready' | 'startup_or_dialog' | 'busy' | 'no_prompt';

export interface AgentPromptReadiness {
  ready: boolean;
  reason: AgentPromptReadinessReason;
  tail: string;
}

const AGENT_STARTUP_OR_DIALOG_PATTERNS: RegExp[] = [
  /\bmodel:\s*loading\b/i,
  /\bBooting\s+MCP\s+server\b/i,
];

const AGENT_TRUST_DIALOG_PATTERNS: RegExp[] = [
  /\bDo\s+you\s+trust\b/i,
  /\bPress\s+enter\s+to\s+continue\b/i,
];

const AGENT_MCP_STARTUP_PATTERN = /\bStarting\s+MCP\s+servers?\s*\(/i;
const AGENT_MCP_STARTUP_COMPLETE_PATTERN = /\bStarting\s+MCP\s+servers?\s+complete\b/i;

const AGENT_BUSY_TAIL_PATTERNS: RegExp[] = [
  /\bq*Working\s*\(/i,
  /\bbackground\s+terminal\s+running\b/i,
  /\besc\s+to\s+interrupt\b/i,
  /\/stop\s+to\s+close\b/i,
];

/** Check stripped output for known agent prompt characters.
 *  Only checks the tail of the chunk — the agent's main prompt renders near
 *  the end of the visible content, while TUI selection UIs place ❯/› earlier
 *  in the render followed by option text and other choices.
 *  AGENT_READY_TAIL_CHARS covers long worktree paths in footer/status lines
 *  below the input prompt. */
export function getAgentPromptReadiness(stripped: string): AgentPromptReadiness {
  if (stripped.length === 0) return { ready: false, reason: 'no_prompt', tail: '' };
  const tail = stripped.slice(-AGENT_READY_TAIL_CHARS);
  const blockerTail = tail.slice(-AGENT_BLOCKER_TAIL_CHARS);
  if (AGENT_BUSY_TAIL_PATTERNS.some((re) => re.test(blockerTail))) {
    return { ready: false, reason: 'busy', tail };
  }
  const lines = tail
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const ready = lines.some((line) => AGENT_READY_TAIL_PATTERNS.some((re) => re.test(line)));
  if (AGENT_STARTUP_OR_DIALOG_PATTERNS.some((re) => re.test(blockerTail))) {
    return { ready: false, reason: 'startup_or_dialog', tail };
  }
  if (
    AGENT_MCP_STARTUP_PATTERN.test(blockerTail) &&
    !AGENT_MCP_STARTUP_COMPLETE_PATTERN.test(blockerTail)
  ) {
    return { ready: false, reason: 'startup_or_dialog', tail };
  }
  if (!ready && AGENT_TRUST_DIALOG_PATTERNS.some((re) => re.test(blockerTail))) {
    return { ready: false, reason: 'startup_or_dialog', tail };
  }
  return { ready, reason: ready ? 'ready' : 'no_prompt', tail };
}

export function chunkContainsAgentPrompt(stripped: string): boolean {
  return getAgentPromptReadiness(stripped).ready;
}
