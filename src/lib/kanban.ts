import { cleanHandoffText } from './agent-handoff';
import {
  CHECKLIST_RE,
  cloneBoard,
  cloneCard,
  singleLine,
  trimBlankLines,
  type KanbanBoard,
  type KanbanCard,
  type KanbanCardRef,
  type KanbanChecklistItem,
  type KanbanColumn,
} from '../../electron/shared/kanban-markdown';

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
 *     group: A theme
 *     related: Another card's title
 *     issue: https://github.com/owner/repo/issues/12
 *     branch: `task/branch-name`
 *
 *   ## Done
 *
 *   - [x] Finished card
 *
 * Each `##` heading is a column, each top-level list item a card, and the
 * indented lines under it the card's description. `- [ ]` items in a
 * description are the card's checklist. A `depends:` line names a card that
 * has to be done first, a `group:` line the theme the card belongs to when
 * the plan is drawn as a mind map, a `related:` line a card it belongs with
 * without waiting for it, an `issue:` line the GitHub issue or pull request the
 * card tracks, and a `branch:` line links the card to the Parallel Code task
 * working on that branch. Anything else inside a column (a
 * paragraph, a sub-heading) is kept as the column's notes, and Obsidian
 * Kanban's front matter and settings block are kept as they are, so a board
 * written by hand, by an agent or in Obsidian survives a round trip.
 */

// The board's parser lives in electron/shared so landing a task can merge board
// edits in the main process; the renderer keeps using this module as its board API.
export {
  parseKanban,
  serializeKanban,
  type KanbanBoard,
  type KanbanCard,
  type KanbanCardRef,
  type KanbanChecklistItem,
  type KanbanColumn,
} from '../../electron/shared/kanban-markdown';

export const DEFAULT_KANBAN_MARKDOWN = `# Kanban

Plan the project here. Each card can start a Parallel Code task.

## Backlog

## In progress

## Review

## Done
`;

const NEGATED_RE = /\b(not|un)[ \t-]*(started|done|finished|complete[d]?)\b/i;
const DONE_COLUMN_RE = /\b(done|complete[d]?|finished|shipped|closed)\b/i;
const ACTIVE_COLUMN_RE = /\b(in progress|doing|active|wip|working|started)\b/i;
const REVIEW_COLUMN_RE = /\b(review|reviewing|qa|testing|verify|verification)\b/i;
const ARCHIVE_COLUMN_RE = /^archived?$/i;

export function isDoneColumn(title: string): boolean {
  return (
    DONE_COLUMN_RE.test(title) && !NEGATED_RE.test(title) && !/definition of done/i.test(title)
  );
}

export function isArchiveColumn(title: string): boolean {
  return ARCHIVE_COLUMN_RE.test(title.trim());
}

function columnIndex(board: KanbanBoard, re: RegExp): number {
  return board.columns.findIndex(
    (column) => re.test(column.title) && !NEGATED_RE.test(column.title),
  );
}

function doneColumnIndex(board: KanbanBoard): number {
  return board.columns.findIndex((column) => isDoneColumn(column.title));
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
  const next = cloneBoard(board);
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
  const next = cloneBoard(board);
  const column: KanbanColumn = {
    title: singleLine(title) || 'Untitled',
    notes: '',
    cards: [],
    after: '',
  };
  // New columns go before an Archive column, which stays last.
  const archive = next.columns.findIndex((c) => isArchiveColumn(c.title));
  if (archive >= 0 && !isArchiveColumn(column.title)) next.columns.splice(archive, 0, column);
  else next.columns.push(column);
  return next;
}

export function renameColumn(board: KanbanBoard, index: number, title: string): KanbanBoard {
  const next = cloneBoard(board);
  const column = next.columns[index];
  if (column) column.title = singleLine(title) || column.title;
  return next;
}

/** Removes a column; its cards are kept by moving them to a neighbouring column. */
export function removeColumn(board: KanbanBoard, index: number): KanbanBoard {
  const next = cloneBoard(board);
  const [removed] = next.columns.splice(index, 1);
  if (removed?.cards.length) {
    const target = next.columns[Math.max(0, index - 1)];
    if (!target) return board;
    for (const card of removed.cards) {
      card.done = doneAfterMove(card.done, removed.title, target.title);
      target.cards.push(card);
    }
  }
  return next;
}

export function moveColumn(board: KanbanBoard, from: number, to: number): KanbanBoard {
  if (from === to || !board.columns[from] || to < 0 || to >= board.columns.length) return board;
  const next = cloneBoard(board);
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
  const next = cloneBoard(board);
  const target = next.columns[column];
  if (!target) return board;
  const card: KanbanCard = {
    title: singleLine(title),
    done: isDoneColumn(target.title),
    body: trimBlankLines(body.split('\n')).join('\n'),
    branches: [],
    depends: [],
    issue: '',
    before: '',
  };
  target.cards.splice(index ?? target.cards.length, 0, card);
  return next;
}

/** Puts a card back where it was, e.g. to undo a delete. */
export function insertCard(board: KanbanBoard, ref: KanbanCardRef, card: KanbanCard): KanbanBoard {
  const next = cloneBoard(board);
  const target = next.columns[ref.column];
  if (!target) return board;
  // Its text above stayed in the column when it was removed.
  target.cards.splice(Math.min(ref.card, target.cards.length), 0, {
    ...cloneCard(card),
    before: '',
  });
  return next;
}

export function updateCard(
  board: KanbanBoard,
  ref: KanbanCardRef,
  change: Partial<Pick<KanbanCard, 'title' | 'body' | 'done' | 'depends' | 'group' | 'issue'>>,
): KanbanBoard {
  const next = cloneBoard(board);
  const card = next.columns[ref.column]?.cards[ref.card];
  if (!card) return board;
  if (change.title !== undefined) card.title = singleLine(change.title) || card.title;
  // Only blank lines are trimmed: leading spaces can be an indented code block.
  if (change.body !== undefined) card.body = trimBlankLines(change.body.split('\n')).join('\n');
  if (change.issue !== undefined) card.issue = change.issue.trim();
  if (change.done !== undefined) card.done = change.done;
  if (change.depends !== undefined) {
    card.depends = [...new Set(change.depends.map(singleLine).filter(Boolean))];
  }
  if (change.group !== undefined) {
    const group = singleLine(change.group);
    if (group) card.group = group;
    else delete card.group;
  }
  return next;
}

/**
 * Takes a card out of its column. Text written above it (a sub-heading over a
 * group of cards) stays in the column: it passes to the next card, or to the
 * column's closing text when the card was the last.
 */
function detachCard(column: KanbanColumn, index: number): KanbanCard {
  const [card] = column.cards.splice(index, 1);
  if (card.before.trim()) {
    const next = column.cards[index];
    if (next) next.before = [card.before, next.before].filter((t) => t.trim()).join('\n\n');
    else column.after = [card.before, column.after].filter((t) => t.trim()).join('\n\n');
  }
  return { ...card, before: '' };
}

export function removeCard(board: KanbanBoard, ref: KanbanCardRef): KanbanBoard {
  const next = cloneBoard(board);
  const column = next.columns[ref.column];
  if (!column?.cards[ref.card]) return board;
  detachCard(column, ref.card);
  return next;
}

/**
 * A card's checkmark after moving between columns: entering a Done column
 * checks it, leaving one for an ordinary column unchecks it, and the Archive
 * column changes nothing either way.
 */
function doneAfterMove(done: boolean, from: string, to: string): boolean {
  if (isArchiveColumn(to) || isArchiveColumn(from)) return done;
  if (isDoneColumn(to)) return true;
  if (isDoneColumn(from)) return false;
  return done;
}

/**
 * Moves a card to `toColumn` before position `toIndex` (the end when omitted),
 * updating its checkmark as `doneAfterMove` says.
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
  const next = cloneBoard(board);
  const card = detachCard(next.columns[from.column], from.card);
  const cards = next.columns[toColumn].cards;
  let index = toIndex ?? cards.length;
  // Removing the card first shifts later positions in the same column up by one.
  if (from.column === toColumn && toIndex !== undefined && toIndex > from.card) index--;
  cards.splice(Math.max(0, Math.min(index, cards.length)), 0, card);
  if (from.column !== toColumn) card.done = doneAfterMove(card.done, source.title, target.title);
  return next;
}

/** Moves a card to the board's Archive column, adding one at the end if needed. */
export function archiveCard(board: KanbanBoard, ref: KanbanCardRef): KanbanBoard {
  if (!board.columns[ref.column]?.cards[ref.card]) return board;
  let next = board;
  let archive = next.columns.findIndex((c) => isArchiveColumn(c.title));
  if (archive === ref.column) return board;
  if (archive < 0) {
    next = cloneBoard(next);
    next.columns.push({ title: 'Archive', notes: '', cards: [], after: '' });
    archive = next.columns.length - 1;
  }
  return moveCard(next, ref, archive, 0);
}

/**
 * What identifies a card besides its title: its description and metadata. The
 * checkmark is left out, since ticking a card must not make it unfindable.
 */
export function cardFingerprint(card: KanbanCard): string {
  return JSON.stringify([
    card.title,
    card.body,
    card.depends,
    card.group ?? '',
    card.related ?? [],
    card.issue,
    card.branches,
  ]);
}

/**
 * Finds a card again after the file may have changed. With a fingerprint, an
 * exact match wins (at its old place, then in its column, then anywhere), so
 * of two cards with the same title the right one is found even after cards
 * moved. Otherwise, or when the card has been edited since: its old place if
 * the title still matches, then the first card with that title in the same
 * column, then anywhere on the board.
 */
export function findCard(
  board: KanbanBoard,
  hint: { title: string; column?: string; ref?: KanbanCardRef; fingerprint?: string },
): KanbanCardRef | null {
  const title = singleLine(hint.title);
  if (hint.fingerprint) {
    const at = (ref: KanbanCardRef) => {
      const card = board.columns[ref.column]?.cards[ref.card];
      return !!card && cardFingerprint(card) === hint.fingerprint;
    };
    if (hint.ref && at(hint.ref)) return hint.ref;
    const order = board.columns
      .map((column, index) => ({ column, index }))
      .sort(
        (a, b) => Number(b.column.title === hint.column) - Number(a.column.title === hint.column),
      );
    for (const { column, index } of order) {
      const card = column.cards.findIndex((c) => cardFingerprint(c) === hint.fingerprint);
      if (card >= 0) return { column: index, card };
    }
  }
  if (hint.ref && board.columns[hint.ref.column]?.cards[hint.ref.card]?.title === title) {
    return hint.ref;
  }
  // An archived copy of the card is never a stand-in for a live one.
  const columns = board.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !isArchiveColumn(column.title) || column.title === hint.column);
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
  const next = cloneBoard(board);
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
  const target = stage === 'done' ? doneColumnIndex(board) : columnIndex(board, REVIEW_COLUMN_RE);
  if (target < 0 || target <= ref.column) {
    if (stage !== 'done') return null;
    // Merged on a board without a Done column ahead: check the card off in place.
    return updateCard(board, ref, { done: true });
  }
  const moved = moveCard(board, ref, target, stage === 'done' ? 0 : undefined);
  return stage === 'done' ? updateCard(moved, { column: target, card: 0 }, { done: true }) : moved;
}

/**
 * The agent prompt for a task started from a card. Card text comes from a file
 * in the repository, which may not be the user's own writing: controls that
 * could end the terminal paste early and invisible characters are removed.
 * The prompt is prefilled for the user to read, never sent on its own.
 */
export function buildKanbanTaskPrompt(board: KanbanBoard, ref: KanbanCardRef): string {
  const column = board.columns[ref.column];
  const card = column?.cards[ref.card];
  if (!column || !card) return '';
  const parts = [card.title || 'Untitled card'];
  if (card.body.trim()) parts.push(card.body.trim());
  if (cardChecklist(card).length) {
    parts.push(
      'Treat the checklist items above as acceptance criteria; the task is done when all of them hold.',
    );
  }
  if (card.depends.length) {
    parts.push(`This card builds on: ${card.depends.join(', ')}.`);
  }
  const issue = parseGitHubIssueUrl(card.issue);
  if (issue) {
    parts.push(
      `It tracks GitHub ${issue.kind === 'pr' ? 'pull request' : 'issue'} ${card.issue}; read it with \`gh\` for the details${issue.kind === 'issue' ? `, and reference it in commits and the pull request (for example "Fixes #${issue.number}")` : ''}.`,
    );
  }
  parts.push(
    `This task comes from the card "${card.title}" in the "${column.title}" column of the project's Kanban board (KANBAN.md).`,
  );
  return cleanHandoffText(parts.join('\n\n'));
}

/** Owner, repository and number of a github.com issue or pull request URL. */
export function parseGitHubIssueUrl(
  url: string,
): { repo: string; number: number; kind: 'issue' | 'pr' } | null {
  const match =
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)(?:[/?#]\S*)?$/.exec(
      url.trim(),
    );
  if (!match) return null;
  return { repo: match[1], number: Number(match[3]), kind: match[2] === 'pull' ? 'pr' : 'issue' };
}

/** The card tracking a GitHub issue or PR, if any. */
export function findCardByIssue(board: KanbanBoard, url: string): KanbanCardRef | null {
  const wanted = parseGitHubIssueUrl(url);
  if (!wanted) return null;
  for (let column = 0; column < board.columns.length; column++) {
    const card = board.columns[column].cards.findIndex((c) => {
      const linked = parseGitHubIssueUrl(c.issue);
      return (
        !!linked &&
        linked.number === wanted.number &&
        linked.repo.toLowerCase() === wanted.repo.toLowerCase()
      );
    });
    if (card >= 0) return { column, card };
  }
  return null;
}

/**
 * Adds a card for a GitHub issue or PR to the first column, unless the board
 * already tracks it. Only the title is copied; the body stays on GitHub, where
 * the agent reads it, so untrusted text never lands in the file unseen.
 */
export function addIssueCard(
  board: KanbanBoard,
  item: { title: string; url: string },
  column = 0,
): KanbanBoard {
  if (findCardByIssue(board, item.url) || !parseGitHubIssueUrl(item.url)) return board;
  const target = Math.min(Math.max(0, column), board.columns.length - 1);
  if (target < 0) return board;
  const added = addCard(board, target, cleanHandoffText(item.title));
  const index = added.columns[target].cards.length - 1;
  return updateCard(added, { column: target, card: index }, { issue: item.url });
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
      '- Give each card an indented `group: <theme>` line naming the part of the goal it belongs to, reusing the themes already on the board where they fit.',
      '- Prefer small cards that touch separate files, so several can run in parallel without conflicts.',
      'Do not implement anything yet. Finish with a short summary of the plan.',
    ].join('\n'),
  ].join('\n\n');
}

/** Asks the board's planning agent to sort the cards into themes for the map. */
export function buildKanbanClusterPrompt(): string {
  return [
    "Sort the cards on the project's Kanban board, KANBAN.md in the project root, into logical clusters for its mind map.",
    [
      'Read the cards (and the code they touch where a title is unclear). Then edit KANBAN.md directly:',
      '- Give every card one indented `group: <theme>` line, replacing any it has. Use a handful of short themes such as a feature, area or goal, not statuses; reuse the same spelling for the same theme.',
      '- Where two cards belong together across themes but neither waits for the other, add an indented `related: <other card title>` line to one of them, using the exact title.',
      '- Change nothing else: keep every card, column, description, checklist and `depends:` line as it is.',
      'Finish with the themes you chose and one line on what each holds.',
    ].join('\n'),
  ].join('\n\n');
}
