import {
  parsePromptMenu,
  samePromptMenu,
  type AgentPromptPeek,
  type PromptMenuSeen,
} from '../shared/prompt-menu.js';

const TAIL_ROWS = 12;

/** Reads the screen through the mirror; null while it has none. */
export type ScreenReader = () => string | null;

/** What the agent's screen shows: its choice dialog, if any, and its last rows. */
export function peekAgentPrompt(screen: ScreenReader): AgentPromptPeek | null {
  const text = screen();
  if (text === null) return null;
  const rows = text.split('\n').map((row) => row.trimEnd());
  while (rows.length > 0 && !rows[rows.length - 1]) rows.pop();
  return { menu: parsePromptMenu(text), tail: rows.slice(-TAIL_ROWS) };
}

/**
 * Picks option `n` only when the screen still shows the dialog the user saw,
 * the same question and choices. Otherwise the key could land in the agent's
 * input box, or answer a dialog the user never read. Returns whether it was sent.
 */
export function answerAgentPrompt(opts: {
  screen: ScreenReader;
  write: (data: string) => void;
  n: number;
  seen: PromptMenuSeen;
}): boolean {
  const text = opts.screen();
  const menu = text === null ? null : parsePromptMenu(text);
  if (!menu || !samePromptMenu(menu, opts.seen)) return false;
  const option = menu.options.find((o) => o.n === opts.n);
  if (!option) return false;
  opts.write(option.key);
  return true;
}
