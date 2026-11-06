/** Strip ANSI escape sequences (CSI, OSC, and single-char escapes) from terminal output. */
export function stripAnsi(text: string): string {
  return text.replace(
    // A full CSI (ECMA-48: parameters, then intermediates, then a final byte) goes
    // first: the older pattern leaves e.g. ` q` of a cursor-shape change behind.
    // eslint-disable-next-line no-control-regex
    /(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]|[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g,
    '',
  );
}

/**
 * Give cursor-positioned output its row structure before ANSI stripping: a move
 * to another row starts a line, a jump within the row becomes a space. Codex
 * 0.163+ draws its whole screen this way without newlines, which otherwise puts
 * the composer mid-line behind the logo where line-anchored patterns miss it.
 */
export function cursorRowsToLines(text: string): string {
  let row: string | undefined;
  // eslint-disable-next-line no-control-regex -- CUP/HVP: ESC [ row ; col H|f
  return text.replace(/\x1b\[(\d*)(?:;\d*)?[Hf]/g, (_match, nextRow: string) => {
    const sameRow = (nextRow || '1') === row;
    row = nextRow || '1';
    return sameRow ? ' ' : '\n';
  });
}

/**
 * Patterns that indicate the agent is waiting for user input (i.e. idle).
 * Each regex is tested against the last non-empty line of stripped output.
 */
export const PROMPT_PATTERNS: RegExp[] = [
  /❯\s*$/,
  /›\s*$/,
  /(?:^|\s)\$\s*$/,
  /(?:^|\s)%\s*$/,
  /(?:^|\s)#\s*$/,
  /\[Y\/n\]\s*$/i,
  /\[y\/N\]\s*$/i,
];

/**
 * Patterns for known agent main input prompts (ready for a new task).
 * Tested against the stripped data chunk (not a single line), because TUI
 * apps like Claude Code use cursor positioning instead of newlines.
 */
export const AGENT_READY_TAIL_PATTERNS: RegExp[] = [
  /^\s*❯\s*$/,
  // Claude Code fills an empty input with a dimmed `Try "…"` suggestion (cut
  // short with … in narrow panes); the dimming is lost with ANSI stripping, so
  // match the suggestion's wording.
  /^\s*❯\s+Try\s+"[^"]*(?:"|…)\s*$/,
  /^\s*--\s*INSERT\s*--(?:$|\s|[^\w].*$)/i,
  // shortcut: matches Codex's placeholder wording. 0.163 also ships "Ask a
  // follow-up question", unseen after turns in fresh or resumed sessions —
  // if it shows up, detect the dimmed placeholder from the mirror's cells
  // instead of adding wording.
  /^\s*[›>]\s*(?:Type your message|Ask Codex to do anything|$)/i,
];

export const AGENT_READY_TAIL_CHARS = 1000;
const AGENT_BLOCKER_TAIL_CHARS = 500;

export type AgentPromptReadinessReason = 'ready' | 'startup_or_dialog' | 'busy' | 'no_prompt';

export interface AgentPromptReadiness {
  ready: boolean;
  reason: AgentPromptReadinessReason;
  tail: string;
}

/**
 * Codex's "Update available" screen (#336). Enter picks "Update now", which
 * runs the package manager and exits Codex, so nothing may be sent into it.
 * `\s*` tolerates the spaces lost in cursor-positioned redraws; "Update now
 * (runs" covers the npm, bun and brew variants.
 */
export const AGENT_UPDATE_MENU_PATTERN = /\bUpdate\s*now\s*\(runs\b/i;

const AGENT_STARTUP_OR_DIALOG_PATTERNS: RegExp[] = [
  /\bmodel:\s*loading\b/i,
  /\bBooting\s+MCP\s+server\b/i,
  AGENT_UPDATE_MENU_PATTERN,
];

/** A selection cursor on a numbered option, e.g. `❯ 1. Yes` or `› 2. Skip`. */
export const SELECTION_CURSOR_LINE = /^\s*[❯›]\s*\d+\./m;
/** The input box back below a menu, even holding typed text: it was answered. */
export const PROMPT_AFTER_MENU = /^\s*[❯›]\s*\d+\.[^]*^\s*[❯›](?!\s*\d+\.)/m;

/**
 * True when line-structured, ANSI-stripped output shows a numbered selection
 * menu with no input prompt drawn below it. Enter would pick the highlighted
 * option, so a prompt must not be sent. Needs real line breaks: run
 * `cursorRowsToLines` on cursor-positioned output before stripping it.
 */
export function showsSelectionMenu(visible: string): boolean {
  return SELECTION_CURSOR_LINE.test(visible) && !PROMPT_AFTER_MENU.test(visible);
}

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
  // A menu drawn over the composer leaves the composer row earlier in the tail
  // (#336), so a ready line alone does not mean the input box is on top.
  if (showsSelectionMenu(blockerTail)) {
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
