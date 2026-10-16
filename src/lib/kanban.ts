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
 *     - [ ] An acceptance criterion
 *     depends: Another card's title
 *     branch: `task/branch-name`
 *
 *   ## Done
 *
 *   - [x] Finished card
 *
 * Each `##` heading is a column, each top-level list item a card, and the
 * indented lines under it the card's description. `- [ ]` items in a
 * description are the card's checklist. A `depends:` line names a card that
 * has to be done first, and a `branch:` line links the card to the Parallel
 * Code task working on that branch. Anything else inside a column (a
 * paragraph, a sub-heading) is kept as the column's notes, and Obsidian
 * Kanban's front matter and settings block are kept as they are, so a board
 * written by hand, by an agent or in Obsidian survives a round trip.
 */

export interface KanbanCard {
  title: string;
  done: boolean;
  /** Description, without the indentation and without `branch:`/`depends:` lines. */
  body: string;
  /** Branches of the tasks started from this card, oldest first. */
  branches: string[];
  /** Titles of the cards this one waits for. */
  depends: string[];
}

export interface KanbanColumn {
  title: string;
  /** Text inside the column that is not a card. */
  notes: string;
  cards: KanbanCard[];
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
const DEPENDS_RE = /^depends(?:\s+on)?:\s*(.+?)\s*$/i;
const CHECKLIST_RE = /^([-*+]\s+\[)([ xX])(\]\s+)(.*)$/;
const DONE_COLUMN_RE = /\b(done|complete[d]?|finished|shipped|closed)\b/i;
const ACTIVE_COLUMN_RE = /\b(in progress|doing|active|wip|working|started)\b/i;
const REVIEW_COLUMN_RE = /\b(review|reviewing|qa|testing|verify|verification)\b/i;
const ARCHIVE_COLUMN_RE = /^archived?$/i;

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

/** Splits off leading YAML front matter. */
function splitFrontmatter(lines: string[]): { frontmatter: string[]; rest: string[] } {
  if (lines[0]?.trim() !== '---') return { frontmatter: [], rest: lines };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) return { frontmatter: [], rest: lines };
  return { frontmatter: lines.slice(0, end + 1), rest: lines.slice(end + 1) };
}

/** Splits off a trailing `%% kanban:settings ... %%` block. */
function splitFooter(lines: string[]): { rest: string[]; footer: string[] } {
  const start = lines.findIndex((line) => /^%%\s*kanban:settings/.test(line.trim()));
  if (start < 0) return { rest: lines, footer: [] };
  return { rest: lines.slice(0, start), footer: trimBlankLines(lines.slice(start)) };
}

export function parseKanban(markdown: string): KanbanBoard {
  const all = markdown.replace(/\r\n?/g, '\n').split('\n');
  const { frontmatter, rest: afterFront } = splitFrontmatter(all);
  const { rest: lines, footer } = splitFooter(afterFront);
  const board: KanbanBoard = {
    frontmatter: frontmatter.join('\n'),
    title: '',
    preamble: '',
    columns: [],
    footer: footer.join('\n'),
  };
  const preamble: string[] = [];
  type ColumnDraft = KanbanColumn & { noteLines: string[] };
  type CardDraft = { title: string; done: boolean; lines: string[] };
  let column: ColumnDraft | null = null;
  let card: CardDraft | null = null;
  const columns: ColumnDraft[] = [];
  let fence = false;

  const finishCard = () => {
    if (!card || !column) return;
    const branches: string[] = [];
    const depends: string[] = [];
    const body: string[] = [];
    let inFence = false;
    for (const line of dedent(trimBlankLines(card.lines))) {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      const branch = !inFence && BRANCH_RE.exec(line.trim());
      const dependency = !inFence && !line.startsWith(' ') && DEPENDS_RE.exec(line.trim());
      if (branch) {
        if (!branches.includes(branch[1])) branches.push(branch[1]);
      } else if (dependency) {
        if (!depends.includes(dependency[1])) depends.push(dependency[1]);
      } else body.push(line);
    }
    column.cards.push({
      title: card.title,
      done: card.done,
      body: trimBlankLines(body).join('\n'),
      branches,
      depends,
    });
    card = null;
  };

  for (const line of lines) {
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
  for (const dependency of card.depends) lines.push(`  depends: ${singleLine(dependency)}`);
  for (const branch of card.branches) lines.push(`  branch: \`${branch}\``);
  return lines.join('\n');
}

export function serializeKanban(board: KanbanBoard): string {
  const parts: string[] = [];
  if (board.frontmatter.trim()) parts.push(board.frontmatter.trim());
  // An Obsidian board (front matter, no title) stays without one.
  if (board.title.trim() || !board.frontmatter.trim()) {
    parts.push(`# ${singleLine(board.title) || 'Kanban'}`);
  }
  if (board.preamble.trim()) parts.push(board.preamble.trim());
  for (const column of board.columns) {
    parts.push(`## ${singleLine(column.title) || 'Untitled'}`);
    if (column.notes.trim()) parts.push(column.notes.trim());
    if (column.cards.length) parts.push(column.cards.map(serializeCard).join('\n'));
  }
  if (board.footer.trim()) parts.push(board.footer.trim());
  return `${parts.join('\n\n')}\n`;
}

function clone(board: KanbanBoard): KanbanBoard {
  return {
    ...board,
    columns: board.columns.map((column) => ({
      ...column,
      cards: column.cards.map((card) => ({
        ...card,
        branches: [...card.branches],
        depends: [...card.depends],
      })),
    })),
  };
}

export function isDoneColumn(title: string): boolean {
  return DONE_COLUMN_RE.test(title);
}

export function isArchiveColumn(title: string): boolean {
  return ARCHIVE_COLUMN_RE.test(title.trim());
}

function columnIndex(board: KanbanBoard, re: RegExp): number {
  return board.columns.findIndex((column) => re.test(column.title));
}

/** The column a started card moves to: the first "In progress"-like column. */
export function activeColumnIndex(board: KanbanBoard): number {
  return columnIndex(board, ACTIVE_COLUMN_RE);
}

/** A card counts as done when it is checked or sits in a Done or Archive column. */
export function isCardDone(board: KanbanBoard, ref: KanbanCardRef): boolean {
  const column = board.columns[ref.column];
  const card = column?.cards[ref.card];
  if (!column || !card) return false;
  return card.done || isDoneColumn(column.title) || isArchiveColumn(column.title);
}

/** The card a title names, or null when no card has that title. */
export function findCardByTitle(board: KanbanBoard, title: string): KanbanCardRef | null {
  const wanted = singleLine(title).toLowerCase();
  for (let column = 0; column < board.columns.length; column++) {
    const card = board.columns[column].cards.findIndex((c) => c.title.toLowerCase() === wanted);
    if (card >= 0) return { column, card };
  }
  return null;
}

/** Dependencies of a card that are on the board and not done yet. */
export function openDependencies(board: KanbanBoard, ref: KanbanCardRef): string[] {
  const card = board.columns[ref.column]?.cards[ref.card];
  if (!card) return [];
  return card.depends.filter((title) => {
    const dependency = findCardByTitle(board, title);
    return dependency !== null && !isCardDone(board, dependency);
  });
}

/** The `- [ ]` items of a card's description. */
export function cardChecklist(card: KanbanCard): KanbanChecklistItem[] {
  const items: KanbanChecklistItem[] = [];
  card.body.split('\n').forEach((line, index) => {
    const match = CHECKLIST_RE.exec(line);
    if (match) items.push({ text: match[4], done: match[2] !== ' ', line: index });
  });
  return items;
}

/** The description without its checklist, for a short preview. */
export function cardSummary(card: KanbanCard): string {
  return trimBlankLines(card.body.split('\n').filter((line) => !CHECKLIST_RE.test(line))).join(
    '\n',
  );
}

export function toggleChecklistItem(
  board: KanbanBoard,
  ref: KanbanCardRef,
  line: number,
): KanbanBoard {
  const next = clone(board);
  const card = next.columns[ref.column]?.cards[ref.card];
  if (!card) return board;
  const lines = card.body.split('\n');
  const match = CHECKLIST_RE.exec(lines[line] ?? '');
  if (!match) return board;
  lines[line] = `${match[1]}${match[2] === ' ' ? 'x' : ' '}${match[3]}${match[4]}`;
  card.body = lines.join('\n');
  return next;
}

export function addColumn(board: KanbanBoard, title: string): KanbanBoard {
  const next = clone(board);
  const column = { title: singleLine(title) || 'Untitled', notes: '', cards: [] };
  // New columns go before an Archive column, which stays last.
  const archive = next.columns.findIndex((c) => isArchiveColumn(c.title));
  if (archive >= 0 && !isArchiveColumn(column.title)) next.columns.splice(archive, 0, column);
  else next.columns.push(column);
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

/** Cleans up one line of pasted text into a card title ("- [ ] x", "1. x", "* x"). */
function pastedTitle(line: string): string {
  return line
    .trim()
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .trim();
}

/** Titles to add for text typed or pasted into the new-card field; one card per line. */
export function titlesFromInput(text: string): string[] {
  return text.split(/\r?\n/).map(pastedTitle).filter(Boolean);
}

export function addCard(
  board: KanbanBoard,
  column: number,
  title: string,
  body = '',
  index?: number,
): KanbanBoard {
  const next = clone(board);
  const target = next.columns[column];
  if (!target) return board;
  const card: KanbanCard = {
    title: singleLine(title) || 'Untitled',
    done: isDoneColumn(target.title),
    body: body.trim(),
    branches: [],
    depends: [],
  };
  target.cards.splice(index ?? target.cards.length, 0, card);
  return next;
}

export function updateCard(
  board: KanbanBoard,
  ref: KanbanCardRef,
  change: Partial<Pick<KanbanCard, 'title' | 'body' | 'done' | 'depends'>>,
): KanbanBoard {
  const next = clone(board);
  const card = next.columns[ref.column]?.cards[ref.card];
  if (!card) return board;
  if (change.title !== undefined) card.title = singleLine(change.title) || card.title;
  if (change.body !== undefined) card.body = change.body.trim();
  if (change.done !== undefined) card.done = change.done;
  if (change.depends !== undefined) {
    card.depends = [...new Set(change.depends.map(singleLine).filter(Boolean))];
  }
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

/** Moves a card to the board's Archive column, adding one at the end if needed. */
export function archiveCard(board: KanbanBoard, ref: KanbanCardRef): KanbanBoard {
  if (!board.columns[ref.column]?.cards[ref.card]) return board;
  let next = board;
  let archive = next.columns.findIndex((c) => isArchiveColumn(c.title));
  if (archive === ref.column) return board;
  if (archive < 0) {
    next = clone(next);
    next.columns.push({ title: 'Archive', notes: '', cards: [] });
    archive = next.columns.length - 1;
  }
  return moveCard(next, ref, archive, 0);
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

/** The card a task branch was recorded under. */
export function findCardByBranch(board: KanbanBoard, branch: string): KanbanCardRef | null {
  for (let column = 0; column < board.columns.length; column++) {
    const card = board.columns[column].cards.findIndex((c) => c.branches.includes(branch));
    if (card >= 0) return { column, card };
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
  if (active < 0 || active === ref.column || isCardDone(next, ref) || ref.column > active) {
    return { board: next, ref };
  }
  const moved = moveCard(next, ref, active, 0);
  return { board: moved, ref: { column: active, card: 0 } };
}

/**
 * Moves the card of a task's branch forward when the task reaches `stage`:
 * `review` (the agent is done or opened a PR) or `done` (the branch merged).
 * Never moves a card backwards and never touches a done card, so a card
 * dragged ahead by hand stays where it was put. Null when nothing changes.
 */
export function advanceCardForBranch(
  board: KanbanBoard,
  branch: string,
  stage: 'review' | 'done',
): KanbanBoard | null {
  const ref = findCardByBranch(board, branch);
  if (!ref || isCardDone(board, ref)) return null;
  const target =
    stage === 'done' ? columnIndex(board, DONE_COLUMN_RE) : columnIndex(board, REVIEW_COLUMN_RE);
  if (target < 0 || target <= ref.column) {
    if (stage !== 'done') return null;
    // Merged on a board without a Done column ahead: check the card off in place.
    const next = updateCard(board, ref, { done: true });
    return next;
  }
  const moved = moveCard(board, ref, target, stage === 'done' ? 0 : undefined);
  return stage === 'done' ? updateCard(moved, { column: target, card: 0 }, { done: true }) : moved;
}

/** The agent prompt for a task started from a card. */
export function buildKanbanTaskPrompt(board: KanbanBoard, ref: KanbanCardRef): string {
  const column = board.columns[ref.column];
  const card = column?.cards[ref.card];
  if (!column || !card) return '';
  const parts = [card.title];
  if (card.body.trim()) parts.push(card.body.trim());
  if (cardChecklist(card).length) {
    parts.push(
      'Treat the checklist items above as acceptance criteria; the task is done when all of them hold.',
    );
  }
  if (card.depends.length) {
    parts.push(`This card builds on: ${card.depends.join(', ')}.`);
  }
  parts.push(
    `This task comes from the card "${card.title}" in the "${column.title}" column of the project's Kanban board (KANBAN.md).`,
  );
  return parts.join('\n\n');
}

/** The prompt the board's planning agent starts with; the user fills in the goal. */
export function buildKanbanPlanPrompt(goal: string): string {
  return [
    `Plan the following goal as cards on the project's Kanban board, KANBAN.md in the project root: ${goal.trim() || '<describe the goal>'}`,
    [
      'Read the code and docs you need first. Then edit KANBAN.md directly:',
      '- `## Heading` lines are columns and `- [ ] Title` lines are cards. Add the new cards to the first column (Backlog); keep every existing card and column as it is.',
      "- Indent a card's description by two spaces under it. Write it so an agent can implement the card on its own in a separate git worktree: what to change, where, and why.",
      '- Add acceptance criteria as indented `- [ ]` items, and `depends: <other card title>` lines (indented) where a card needs another one done first.',
      '- Prefer small cards that touch separate files, so several can run in parallel without conflicts.',
      'Do not implement anything yet. Finish with a short summary of the plan.',
    ].join('\n'),
  ].join('\n\n');
}
