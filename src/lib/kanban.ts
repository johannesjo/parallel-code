/**
 * A Kanban board stored as plain Markdown (KANBAN.md at the project root):
 *
 *   # Board title
 *
 *   Optional notes about the board.
 *
 *   ## Backlog
 *
 *   - [ ] Card title
 *     Description lines, indented under the card.
 *     branch: `task/branch-name`
 *
 *   ## Done
 *
 *   - [x] Finished card
 *
 * Each `##` heading is a column, each top-level list item a card, and the
 * indented lines under it the card's description. A `branch:` line links the
 * card to the Parallel Code task working on that branch. Anything else inside a
 * column (a paragraph, a sub-heading) is kept as the column's notes, so a board
 * written by hand or by an agent survives a round trip through the UI.
 */

export interface KanbanCard {
  title: string;
  done: boolean;
  /** Description, without the indentation and without `branch:` lines. */
  body: string;
  /** Branches of the tasks started from this card, oldest first. */
  branches: string[];
}

export interface KanbanColumn {
  title: string;
  /** Text inside the column that is not a card. */
  notes: string;
  cards: KanbanCard[];
}

export interface KanbanBoard {
  title: string;
  /** Text between the board title and the first column. */
  preamble: string;
  columns: KanbanColumn[];
}

/** Where a card sits on the board. */
export interface KanbanCardRef {
  column: number;
  card: number;
}

export const DEFAULT_KANBAN_MARKDOWN = `# Kanban

Plan the project here. Each card can start a Parallel Code task.

## Backlog

## In progress

## Review

## Done
`;

const COLUMN_RE = /^##\s+(.*?)\s*#*\s*$/;
const BOARD_TITLE_RE = /^#\s+(.*?)\s*#*\s*$/;
const CARD_RE = /^[-*+]\s+(?:\[([ xX])\]\s*)?(.*)$/;
const INDENTED_RE = /^(?:\t| {2,})/;
const BRANCH_RE = /^branch:\s*`?([^`\s]+)`?\s*$/i;
const DONE_COLUMN_RE = /\b(done|complete[d]?|finished|shipped|closed)\b/i;
const ACTIVE_COLUMN_RE = /\b(in progress|doing|active|wip|working|started)\b/i;

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}

/** Removes the indentation every non-blank line shares (tabs count as four spaces). */
function dedent(lines: string[]): string[] {
  const expanded = lines.map((line) => line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length)));
  const indents = expanded
    .filter((line) => line.trim())
    .map((line) => line.length - line.trimStart().length);
  const common = indents.length ? Math.min(...indents) : 0;
  return expanded.map((line) =>
    line.slice(Math.min(common, line.length - line.trimStart().length)),
  );
}

function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

export function parseKanban(markdown: string): KanbanBoard {
  const board: KanbanBoard = { title: '', preamble: '', columns: [] };
  const preamble: string[] = [];
  let column: (KanbanColumn & { noteLines: string[] }) | null = null;
  let card: (KanbanCard & { lines: string[] }) | null = null;
  const columns: (KanbanColumn & { noteLines: string[] })[] = [];
  let fence = false;

  const finishCard = () => {
    if (!card || !column) return;
    const lines = dedent(trimBlankLines(card.lines));
    const body: string[] = [];
    for (const line of lines) {
      const branch = BRANCH_RE.exec(line.trim());
      if (branch) {
        if (!card.branches.includes(branch[1])) card.branches.push(branch[1]);
      } else body.push(line);
    }
    column.cards.push({
      title: card.title,
      done: card.done,
      body: trimBlankLines(body).join('\n'),
      branches: card.branches,
    });
    card = null;
  };

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    // A fenced code block inside a description must not start columns or cards.
    const fenceLine = /^\s*(```|~~~)/.test(line);
    if (!fence) {
      const heading = COLUMN_RE.exec(line);
      if (heading) {
        finishCard();
        column = { title: heading[1], notes: '', cards: [], noteLines: [] };
        columns.push(column);
        continue;
      }
      if (!column) {
        const title = BOARD_TITLE_RE.exec(line);
        if (title && !board.title && !preamble.some((l) => l.trim())) board.title = title[1];
        else preamble.push(line);
        continue;
      }
      const item = CARD_RE.exec(line);
      if (item) {
        finishCard();
        card = {
          title: item[2].trim(),
          done: item[1] !== undefined && item[1] !== ' ',
          body: '',
          branches: [],
          lines: [],
        };
        continue;
      }
    }
    if (fenceLine) fence = !fence;
    if (!column) {
      preamble.push(line);
      continue;
    }
    if (card && (fence || INDENTED_RE.test(line) || !line.trim())) {
      card.lines.push(line);
      continue;
    }
    finishCard();
    column.noteLines.push(line);
  }
  finishCard();

  board.preamble = trimBlankLines(preamble).join('\n');
  board.columns = columns.map(({ noteLines, ...rest }) => ({
    ...rest,
    notes: trimBlankLines(noteLines).join('\n'),
  }));
  return board;
}

function serializeCard(card: KanbanCard): string {
  const lines = [`- [${card.done ? 'x' : ' '}] ${singleLine(card.title) || 'Untitled'}`];
  const body = card.body.replace(/\r\n?/g, '\n');
  for (const line of trimBlankLines(body.split('\n'))) lines.push(line.trim() ? `  ${line}` : '');
  for (const branch of card.branches) lines.push(`  branch: \`${branch}\``);
  return lines.join('\n');
}

export function serializeKanban(board: KanbanBoard): string {
  const parts: string[] = [`# ${singleLine(board.title) || 'Kanban'}`];
  if (board.preamble.trim()) parts.push(board.preamble.trim());
  for (const column of board.columns) {
    parts.push(`## ${singleLine(column.title) || 'Untitled'}`);
    if (column.notes.trim()) parts.push(column.notes.trim());
    if (column.cards.length) parts.push(column.cards.map(serializeCard).join('\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

function clone(board: KanbanBoard): KanbanBoard {
  return {
    ...board,
    columns: board.columns.map((column) => ({
      ...column,
      cards: column.cards.map((card) => ({ ...card, branches: [...card.branches] })),
    })),
  };
}

export function isDoneColumn(title: string): boolean {
  return DONE_COLUMN_RE.test(title);
}

/** The column a started card moves to: the first "In progress"-like column. */
export function activeColumnIndex(board: KanbanBoard): number {
  return board.columns.findIndex((column) => ACTIVE_COLUMN_RE.test(column.title));
}

export function addColumn(board: KanbanBoard, title: string): KanbanBoard {
  const next = clone(board);
  next.columns.push({ title: singleLine(title) || 'Untitled', notes: '', cards: [] });
  return next;
}

export function renameColumn(board: KanbanBoard, index: number, title: string): KanbanBoard {
  const next = clone(board);
  const column = next.columns[index];
  if (column) column.title = singleLine(title) || column.title;
  return next;
}

/** Removes a column; its cards are kept by moving them to a neighbouring column. */
export function removeColumn(board: KanbanBoard, index: number): KanbanBoard {
  const next = clone(board);
  const [removed] = next.columns.splice(index, 1);
  if (removed?.cards.length) {
    const target = next.columns[Math.max(0, index - 1)];
    if (!target) return board;
    target.cards.push(...removed.cards);
  }
  return next;
}

export function moveColumn(board: KanbanBoard, from: number, to: number): KanbanBoard {
  if (from === to || !board.columns[from] || to < 0 || to >= board.columns.length) return board;
  const next = clone(board);
  const [column] = next.columns.splice(from, 1);
  next.columns.splice(to, 0, column);
  return next;
}

export function addCard(board: KanbanBoard, column: number, title: string, body = ''): KanbanBoard {
  const next = clone(board);
  const target = next.columns[column];
  if (!target) return board;
  target.cards.push({
    title: singleLine(title) || 'Untitled',
    done: isDoneColumn(target.title),
    body: body.trim(),
    branches: [],
  });
  return next;
}

export function updateCard(
  board: KanbanBoard,
  ref: KanbanCardRef,
  change: Partial<Pick<KanbanCard, 'title' | 'body' | 'done'>>,
): KanbanBoard {
  const next = clone(board);
  const card = next.columns[ref.column]?.cards[ref.card];
  if (!card) return board;
  if (change.title !== undefined) card.title = singleLine(change.title) || card.title;
  if (change.body !== undefined) card.body = change.body.trim();
  if (change.done !== undefined) card.done = change.done;
  return next;
}

export function removeCard(board: KanbanBoard, ref: KanbanCardRef): KanbanBoard {
  const next = clone(board);
  const column = next.columns[ref.column];
  if (!column?.cards[ref.card]) return board;
  column.cards.splice(ref.card, 1);
  return next;
}

/**
 * Moves a card to `toColumn` before position `toIndex` (the end when omitted).
 * Entering a "Done" column checks the card; leaving one unchecks it.
 */
export function moveCard(
  board: KanbanBoard,
  from: KanbanCardRef,
  toColumn: number,
  toIndex?: number,
): KanbanBoard {
  const source = board.columns[from.column];
  const target = board.columns[toColumn];
  if (!source?.cards[from.card] || !target) return board;
  const next = clone(board);
  const [card] = next.columns[from.column].cards.splice(from.card, 1);
  const cards = next.columns[toColumn].cards;
  let index = toIndex ?? cards.length;
  // Removing the card first shifts later positions in the same column up by one.
  if (from.column === toColumn && toIndex !== undefined && toIndex > from.card) index--;
  cards.splice(Math.max(0, Math.min(index, cards.length)), 0, card);
  if (from.column !== toColumn) {
    if (isDoneColumn(target.title)) card.done = true;
    else if (isDoneColumn(source.title)) card.done = false;
  }
  return next;
}

/**
 * Finds a card again after the file may have changed: first at its old place if
 * the title still matches, then the first card with that title in the same
 * column, then anywhere on the board.
 */
export function findCard(
  board: KanbanBoard,
  hint: { title: string; column?: string; ref?: KanbanCardRef },
): KanbanCardRef | null {
  const title = singleLine(hint.title);
  if (hint.ref && board.columns[hint.ref.column]?.cards[hint.ref.card]?.title === title) {
    return hint.ref;
  }
  const columns = board.columns.map((column, index) => ({ column, index }));
  const preferred = columns.filter(({ column }) => column.title === hint.column);
  for (const { column, index } of [...preferred, ...columns]) {
    const card = column.cards.findIndex((c) => c.title === title);
    if (card >= 0) return { column: index, card };
  }
  return null;
}

/**
 * Records that a task on `branch` was started from the card, and moves the card
 * to the board's "In progress" column when it has one and the card is not done.
 */
export function linkCardToBranch(
  board: KanbanBoard,
  ref: KanbanCardRef,
  branch: string,
): { board: KanbanBoard; ref: KanbanCardRef } {
  const next = clone(board);
  const card = next.columns[ref.column]?.cards[ref.card];
  const name = branch.trim();
  if (!card || !name || /[\s`]/.test(name)) return { board, ref };
  if (!card.branches.includes(name)) card.branches.push(name);
  const active = activeColumnIndex(next);
  if (
    active < 0 ||
    active === ref.column ||
    card.done ||
    isDoneColumn(next.columns[ref.column].title)
  ) {
    return { board: next, ref };
  }
  const moved = moveCard(next, ref, active, 0);
  return { board: moved, ref: { column: active, card: 0 } };
}

/** The agent prompt for a task started from a card. */
export function buildKanbanTaskPrompt(board: KanbanBoard, ref: KanbanCardRef): string {
  const column = board.columns[ref.column];
  const card = column?.cards[ref.card];
  if (!column || !card) return '';
  const parts = [card.title];
  if (card.body.trim()) parts.push(card.body.trim());
  parts.push(
    `This task comes from the card "${card.title}" in the "${column.title}" column of the project's Kanban board (KANBAN.md).`,
  );
  return parts.join('\n\n');
}
