/**
 * Parsing and writing of a Kanban board stored as Markdown (KANBAN.md). Pure,
 * so the renderer (src/lib/kanban.ts, which documents the format) and the
 * main process (landing a task merges board edits, #337) share one parser.
 */
export interface KanbanCard {
  title: string;
  done: boolean;
  /** Description, without the card's indentation and without its metadata lines. */
  body: string;
  /** Branches of the tasks started from this card, oldest first. */
  branches: string[];
  /** Titles of the cards this one waits for. */
  depends: string[];
  /** The theme the card is clustered under in the map; absent when none. */
  group?: string;
  /** Titles of cards this one belongs with, without waiting for them. */
  related?: string[];
  /** The GitHub issue or pull request the card tracks, as a URL; empty when none. */
  issue: string;
  /** Further `issue:` lines, kept in order after the first. */
  extraIssues?: string[];
  /**
   * Column text written between the previous card and this one (a sub-heading
   * grouping the cards below it, say). It travels with the card, so the text
   * keeps its place relative to the cards around it.
   */
  before: string;
}

export interface KanbanColumn {
  title: string;
  /** Text inside the column before its first card. */
  notes: string;
  cards: KanbanCard[];
  /** Text inside the column after its last card. */
  after: string;
}

export interface KanbanBoard {
  /** YAML front matter, delimiters included (Obsidian Kanban writes one). */
  frontmatter: string;
  title: string;
  /** Text between the board title and the first column. */
  preamble: string;
  columns: KanbanColumn[];
  /** Trailing `%% kanban:settings %%` block written by Obsidian Kanban. */
  footer: string;
  /** The file's line ending and byte-order mark, kept on write. */
  eol: '\n' | '\r\n';
  bom: boolean;
}

/** Where a card sits on the board. */
export interface KanbanCardRef {
  column: number;
  card: number;
}

export interface KanbanChecklistItem {
  text: string;
  done: boolean;
  /** Line index inside the card's body. */
  line: number;
}

// Headings need a space before closing hashes, so `## C#` keeps its `#`.
const COLUMN_RE = /^ {0,3}##(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const BOARD_TITLE_RE = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const CARD_RE = /^ ?[-*+](?:[ \t]+(?:\[([ xX])\](?=[ \t]|$))?[ \t]*(.*))?$/;
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE_OPEN_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const FOOTER_RE = /^%%\s*kanban:settings/;
// The app writes these exactly; prose that merely starts with "Branch:" stays prose.
const BRANCH_RE = /^branch:[ \t]*`([^`\s]+)`[ \t]*$/;
const DEPENDS_RE = /^depends:[ \t]*(\S.*?)[ \t]*$/;
const GROUP_RE = /^group:[ \t]*(\S.*?)[ \t]*$/;
const RELATED_RE = /^related:[ \t]*(\S.*?)[ \t]*$/;
const ISSUE_RE = /^issue:[ \t]*(https:\/\/github\.com\/\S+)[ \t]*$/;
export const CHECKLIST_RE = /^([ \t]*[-*+][ \t]+\[)([ xX])(\][ \t]+)(.*)$/;

export function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}

export function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** Leading whitespace width, a tab counting as four columns. */
function indentOf(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width++;
    else if (ch === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** Removes a card's content indentation: up to two spaces or one tab. */
function stripCardIndent(line: string): string {
  if (line.startsWith('\t')) return line.slice(1);
  return line.replace(/^ {1,2}/, '');
}

interface Fence {
  char: string;
  length: number;
  indent: number;
}

/** The fence a line opens, following CommonMark: a backtick fence's info has no backtick. */
function fenceOpening(line: string): Fence | null {
  const match = FENCE_OPEN_RE.exec(line);
  if (!match) return null;
  if (match[2][0] === '`' && match[3].includes('`')) return null;
  return { char: match[2][0], length: match[2].length, indent: indentOf(match[1]) };
}

function closesFence(line: string, fence: Fence): boolean {
  const trimmed = line.trim();
  return trimmed.length >= fence.length && [...trimmed].every((ch) => ch === fence.char);
}

/** Whether a line leaves an HTML comment open. */
/**
 * Whether a line opens an HTML comment block that it leaves open. As in
 * CommonMark, only a line that starts with `<!--` does; a `<!--` mentioned
 * mid-sentence is plain text.
 */
function opensComment(line: string): boolean {
  return /^[ \t]*<!--/.test(line) && !line.slice(line.indexOf('<!--') + 4).includes('-->');
}

/**
 * Tracks code fences and HTML comments across lines, so text inside them is
 * never read as board structure.
 */
class Literal {
  fence: Fence | null = null;
  comment = false;

  get active(): boolean {
    return this.fence !== null || this.comment;
  }

  /** Feeds one line that is not structure; returns nothing. */
  feed(line: string): void {
    if (this.fence) {
      if (closesFence(line, this.fence)) this.fence = null;
      return;
    }
    if (this.comment) {
      if (line.includes('-->')) this.comment = false;
      return;
    }
    const fence = fenceOpening(line);
    if (fence) this.fence = fence;
    else if (opensComment(line)) this.comment = true;
  }
}

/** YAML front matter: a leading `---` block that reads like keys and values. */
function splitFrontmatter(lines: string[]): { frontmatter: string[]; rest: string[] } {
  if (lines[0]?.trim() !== '---') return { frontmatter: [], rest: lines };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) return { frontmatter: [], rest: lines };
  const inner = lines.slice(1, end);
  const yamlish = inner.every(
    (line) => !line.trim() || /^[\w-]+[ \t]*:/.test(line) || /^[ \t]/.test(line),
  );
  if (!yamlish || !inner.some((line) => /^[\w-]+[ \t]*:/.test(line))) {
    return { frontmatter: [], rest: lines };
  }
  return { frontmatter: lines.slice(0, end + 1), rest: lines.slice(end + 1) };
}

/** Splits a card's raw lines into description and metadata. */
function readCardBody(
  raw: string[],
): Pick<
  KanbanCard,
  'body' | 'branches' | 'depends' | 'group' | 'related' | 'issue' | 'extraIssues'
> {
  const lines = trimBlankLines(raw.map(stripCardIndent));
  const top = Math.min(...lines.filter((l) => l.trim()).map(indentOf), Infinity);
  const literal = new Literal();
  const branches: string[] = [];
  const depends: string[] = [];
  let group = '';
  const related: string[] = [];
  let issue = '';
  const extraIssues: string[] = [];
  const body: string[] = [];
  for (const line of lines) {
    if (!literal.active && line.trim() && indentOf(line) === top) {
      const text = line.trim();
      const branch = BRANCH_RE.exec(text);
      const dependency = DEPENDS_RE.exec(text);
      const linked = ISSUE_RE.exec(text);
      const theme = GROUP_RE.exec(text);
      const relation = RELATED_RE.exec(text);
      if (branch) {
        if (!branches.includes(branch[1])) branches.push(branch[1]);
        continue;
      }
      if (dependency) {
        if (!depends.includes(dependency[1])) depends.push(dependency[1]);
        continue;
      }
      // A card has one theme; the last line wins, so a re-added line replaces
      // the old one and clearing the theme never brings an earlier one back.
      if (theme) {
        group = theme[1];
        continue;
      }
      if (relation) {
        if (!related.includes(relation[1])) related.push(relation[1]);
        continue;
      }
      if (linked) {
        if (!issue) issue = linked[1];
        else extraIssues.push(linked[1]);
        continue;
      }
    }
    literal.feed(line);
    body.push(line);
  }
  return {
    body: trimBlankLines(body).join('\n'),
    branches,
    depends,
    ...(group ? { group } : {}),
    ...(related.length ? { related } : {}),
    issue,
    ...(extraIssues.length ? { extraIssues } : {}),
  };
}

export function parseKanban(markdown: string): KanbanBoard {
  const bom = markdown.startsWith('﻿');
  const text = bom ? markdown.slice(1) : markdown;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  const all = text.replace(/\r\n?/g, '\n').split('\n');
  const { frontmatter, rest: lines } = splitFrontmatter(all);
  const board: KanbanBoard = {
    frontmatter: frontmatter.join('\n'),
    title: '',
    preamble: '',
    columns: [],
    footer: '',
    eol: crlf > 0 && crlf * 2 >= lf ? '\r\n' : '\n',
    bom,
  };

  type ColumnDraft = { title: string; notes: string[]; cards: KanbanCard[]; pending: string[] };
  type CardDraft = { title: string; done: boolean; lines: string[]; before: string[] };
  const preamble: string[] = [];
  const columns: ColumnDraft[] = [];
  let column: ColumnDraft | null = null;
  let card: CardDraft | null = null;
  // Fences and comments in notes and the preamble; a card tracks its own.
  const literal = new Literal();
  const cardLiteral = new Literal();

  const finishCard = () => {
    if (!card || !column) return;
    column.cards.push({
      title: card.title,
      done: card.done,
      before: trimBlankLines(card.before).join('\n'),
      ...readCardBody(card.lines),
    });
    card = null;
  };

  /** Text that is not a card: the preamble, a column's notes, or between cards. */
  const note = (line: string) => {
    literal.feed(line);
    if (!column) preamble.push(line);
    else if (!column.cards.length && !card) column.notes.push(line);
    else column.pending.push(line);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (card) {
      // A card's content is indented; a fence or comment inside it ends with the card.
      const indented = !line.trim() || indentOf(line) >= 2;
      if (cardLiteral.active && indented) {
        cardLiteral.feed(line);
        card.lines.push(line);
        continue;
      }
      if (indented) {
        cardLiteral.feed(line);
        card.lines.push(line);
        continue;
      }
      const previous = card.lines.length ? card.lines[card.lines.length - 1] : 'title';
      const lazy =
        !cardLiteral.active &&
        previous.trim() !== '' &&
        !CARD_RE.test(line) &&
        !COLUMN_RE.test(line) &&
        !THEMATIC_BREAK_RE.test(line) &&
        !/^ {0,3}(#|>|```|~~~|<!--|%%)/.test(line);
      if (lazy) {
        // A paragraph continued without indentation still belongs to the card.
        card.lines.push(line);
        continue;
      }
      cardLiteral.fence = null;
      cardLiteral.comment = false;
      finishCard();
    }

    if (literal.active) {
      note(line);
      continue;
    }
    if (FOOTER_RE.test(line)) {
      board.footer = trimBlankLines(lines.slice(i)).join('\n');
      break;
    }
    const heading = COLUMN_RE.exec(line);
    if (heading) {
      column = { title: heading[1] ?? '', notes: [], cards: [], pending: [] };
      columns.push(column);
      continue;
    }
    if (!column) {
      const title = BOARD_TITLE_RE.exec(line);
      if (title && !board.title && !preamble.some((l) => l.trim())) board.title = title[1];
      else note(line);
      continue;
    }
    const item = !THEMATIC_BREAK_RE.test(line) && CARD_RE.exec(line);
    if (item) {
      card = {
        title: (item[2] ?? '').trim(),
        done: item[1] !== undefined && item[1] !== ' ',
        lines: [],
        before: column.cards.length ? column.pending : [],
      };
      if (!column.cards.length) column.notes.push(...column.pending);
      column.pending = [];
      continue;
    }
    note(line);
  }
  finishCard();

  board.preamble = trimBlankLines(preamble).join('\n');
  board.columns = columns.map((c) => ({
    title: c.title,
    notes: trimBlankLines(c.notes).join('\n'),
    cards: c.cards,
    after: trimBlankLines(c.pending).join('\n'),
  }));
  return board;
}

/** Closes a fence or comment a description leaves open, so nothing after it is swallowed. */
function closeOpenLiterals(lines: string[]): string[] {
  const literal = new Literal();
  for (const line of lines) literal.feed(line);
  const closing: string[] = [];
  if (literal.fence) closing.push(literal.fence.char.repeat(literal.fence.length));
  if (literal.comment) closing.push('-->');
  return closing.length ? [...lines, ...closing] : lines;
}

/**
 * Free text (preamble, notes, text between cards) as written: only blank edge
 * lines go, since leading spaces can make it an indented code block. A fence
 * or comment it leaves open is closed, so cards written after it stay cards.
 */
function block(text: string): string {
  return closeOpenLiterals(trimBlankLines(text.replace(/\r\n?/g, '\n').split('\n'))).join('\n');
}

function serializeCard(card: KanbanCard): string {
  const lines: string[] = [];
  if (card.before.trim()) lines.push(block(card.before), '');
  const title = singleLine(card.title);
  lines.push(`- [${card.done ? 'x' : ' '}]${title ? ` ${title}` : ''}`);
  const body = closeOpenLiterals(trimBlankLines(card.body.replace(/\r\n?/g, '\n').split('\n')));
  for (const line of body) lines.push(line.trim() ? `  ${line}` : '');
  if (card.issue) lines.push(`  issue: ${card.issue}`);
  for (const url of card.extraIssues ?? []) lines.push(`  issue: ${url}`);
  for (const dependency of card.depends) lines.push(`  depends: ${singleLine(dependency)}`);
  if (card.group?.trim()) lines.push(`  group: ${singleLine(card.group)}`);
  for (const title of card.related ?? []) lines.push(`  related: ${singleLine(title)}`);
  for (const branch of card.branches) lines.push(`  branch: \`${branch}\``);
  return lines.join('\n');
}

export function serializeKanban(board: KanbanBoard): string {
  const parts: string[] = [];
  if (board.frontmatter.trim()) parts.push(board.frontmatter.trim());
  if (board.title.trim()) parts.push(`# ${singleLine(board.title)}`);
  if (board.preamble.trim()) parts.push(block(board.preamble));
  for (const column of board.columns) {
    const title = singleLine(column.title);
    parts.push(title ? `## ${title}` : '##');
    if (column.notes.trim()) parts.push(block(column.notes));
    if (column.cards.length) {
      // A card with text before it starts a new block, so the text stays a paragraph.
      const blocks: string[][] = [[]];
      for (const card of column.cards) {
        if (card.before.trim() && blocks[blocks.length - 1].length) blocks.push([]);
        blocks[blocks.length - 1].push(serializeCard(card));
      }
      for (const block of blocks) parts.push(block.join('\n'));
    }
    if (column.after.trim()) parts.push(block(column.after));
  }
  if (board.footer.trim()) parts.push(board.footer.trim());
  const text = `${parts.join('\n\n')}\n`;
  return `${board.bom ? '﻿' : ''}${board.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text}`;
}

export function cloneCard(card: KanbanCard): KanbanCard {
  return {
    ...card,
    branches: [...card.branches],
    depends: [...card.depends],
    ...(card.related ? { related: [...card.related] } : {}),
  };
}

export function cloneBoard(board: KanbanBoard): KanbanBoard {
  return {
    ...board,
    columns: board.columns.map((column) => ({ ...column, cards: column.cards.map(cloneCard) })),
  };
}
