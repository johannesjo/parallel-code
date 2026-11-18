/**
 * Reads the numbered choice dialog an agent's terminal shows (Claude Code's
 * permission and question dialogs, Codex approvals, Gemini's radio lists), so
 * the board can offer the same choices without opening the task. Pure: works
 * on the visible screen text, one row per line, as the main-process mirror
 * reports it.
 */

/** One choice in the dialog. */
export interface PromptMenuOption {
  /** The number the dialog shows, 1-based. */
  n: number;
  /** The option's text without its key hint, e.g. `Yes, proceed`. */
  label: string;
  /** The description or wrapped text on the rows below the option, if any. */
  detail?: string;
  /** What to type to pick it: the dialog's own key hint, else the number. */
  key: string;
  /** Picking it asks for typed instructions next ("tell Claude what to do differently"). */
  typed: boolean;
}

export interface PromptMenu {
  /** The dialog's text above the choices, borders removed; blank rows collapsed. */
  body: string[];
  options: PromptMenuOption[];
}

/** What an agent's screen asks right now, for the board's peek. */
export interface AgentPromptPeek {
  /** The choice dialog on screen, or null when none waits. */
  menu: PromptMenu | null;
  /** The screen's last non-blank rows, for agents that ask without a dialog. */
  tail: string[];
}

export const ESC = '\x1b';
const MAX_BODY_LINES = 12;
// Gemini marks the selected radio option with ●; elsewhere ● is an output bullet,
// so it only counts before a number.
const OPTION_LINE = /^(?:[❯›●]\s*)?(\d+)\.\s+(.+)$/;
const CURSOR_OPTION = /^[❯›●]\s*\d+\.\s/;
/** An input prompt back below the choices means they are history, already answered. */
const INPUT_PROMPT = /^[❯›](?!\s*\d+\.)/;
/** A dialog's top edge or separator: nothing above it belongs to the dialog. */
const RULE_LINE = /^[─━═╭╮┌┐╰╯└┘\-\s]+$/;
const KEY_HINT = /\s*\((esc|[a-z])\)$/i;
const TYPED_OPTION = /\bwhat to do differently\b|\btype something\b/i;

/** The row without a surrounding box border (`│ … │`) and outer spaces. */
function unbox(line: string): string {
  return line
    .replace(/^\s*[│┃|]\s?/, '')
    .replace(/\s?[│┃|]\s*$/, '')
    .trim();
}

interface RawOption {
  n: number;
  text: string;
  detail: string[];
}

/**
 * `letterKeys`: every choice names a letter key, as Codex's do. Otherwise a
 * bracketed letter is part of the label ("Use plan (b)"); only (esc) is a key.
 */
function toOption(raw: RawOption, letterKeys: boolean): PromptMenuOption {
  const hint = KEY_HINT.exec(raw.text)?.[1]?.toLowerCase();
  const isKey = hint === 'esc' || (hint !== undefined && letterKeys);
  const label = isKey ? raw.text.replace(KEY_HINT, '').trim() : raw.text.trim();
  const key = !isKey ? String(raw.n) : hint === 'esc' ? ESC : (hint ?? '');
  const detail = raw.detail.join(' ');
  return { n: raw.n, label, key, typed: TYPED_OPTION.test(label), ...(detail ? { detail } : {}) };
}

/** The rows above the first choice that belong to the dialog. */
function dialogBody(rows: string[], firstOption: number): string[] {
  const body: string[] = [];
  for (let i = firstOption - 1; i >= 0 && body.length < MAX_BODY_LINES; i--) {
    const row = rows[i] ?? '';
    if (row && RULE_LINE.test(row)) break;
    // One blank row keeps paragraphs apart; more say nothing.
    if (!row && !body[0]) continue;
    body.unshift(row);
  }
  while (body[0] === '') body.shift();
  return body;
}

/**
 * The dialog on screen, or null when no choice dialog is waiting: no option
 * has the selection cursor, or the input prompt is back below the choices.
 * Option text wrapped onto following rows is joined back up.
 */
export function parsePromptMenu(screen: string): PromptMenu | null {
  const rows = screen.split(/\r?\n/).map(unbox);
  // Older lib target: no findLastIndex.
  let cursorRow = -1;
  rows.forEach((row, i) => {
    if (CURSOR_OPTION.test(row)) cursorRow = i;
  });
  if (cursorRow < 0) return null;
  if (rows.slice(cursorRow + 1).some((row) => INPUT_PROMPT.test(row))) return null;
  // Walk up to option 1, then down through consecutive numbers.
  let first = cursorRow;
  for (let i = cursorRow; i >= 0; i--) {
    const match = OPTION_LINE.exec(rows[i] ?? '');
    if (match) {
      first = i;
      if (match[1] === '1') break;
    } else if (!rows[i]) break;
  }
  const options: RawOption[] = [];
  // Rows between two options are the first one's description or wrapped text;
  // rows after the last option are hints like "Esc to cancel" and are dropped.
  let between: string[] = [];
  for (let i = first; i < rows.length; i++) {
    const row = rows[i] ?? '';
    const match = OPTION_LINE.exec(row);
    if (match && Number(match[1]) === options.length + 1) {
      options[options.length - 1]?.detail.push(...between);
      between = [];
      options.push({ n: Number(match[1]), text: match[2] ?? '', detail: [] });
    } else if (row) between.push(row);
    else if (i > cursorRow) break;
  }
  if (options[0]?.n !== 1) return null;
  const letterKeys = options.every((o) => KEY_HINT.test(o.text));
  return {
    body: dialogBody(rows, first),
    options: options.map((o) => toOption(o, letterKeys)),
  };
}

/** What the user saw of a dialog: enough to tell it apart from the next one. */
export interface PromptMenuSeen {
  body: readonly string[];
  labels: readonly string[];
}

export function seenPromptMenu(menu: PromptMenu): PromptMenuSeen {
  return { body: menu.body, labels: menu.options.map((option) => option.label) };
}

const sameLines = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * True when `menu` is the dialog the user saw. The question counts as well as
 * the choices: Claude asks about each command with the same three options.
 */
export function samePromptMenu(menu: PromptMenu, seen: PromptMenuSeen): boolean {
  return sameLines(menu.body, seen.body) && sameLines(seenPromptMenu(menu).labels, seen.labels);
}
