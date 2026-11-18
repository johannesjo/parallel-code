import {
  cloneBoard,
  parseKanban,
  serializeKanban,
  type KanbanBoard,
  type KanbanCard,
} from '../shared/kanban-markdown.js';

/** What the app changed on one card: where it sits, its checkbox, its task branches. */
interface CardEdit {
  title: string;
  /** The columns the app moved the card between; null when it stayed in its column. */
  move: { from: string; to: string } | null;
  /** The card above it in its column, or null when it is the column's first. */
  after: string | null;
  /** The checkbox the app set; null when the app left it alone. */
  done: boolean | null;
  /** Branches the app linked; it never unlinks one, and the replay check rejects that. */
  addedBranches: string[];
}

type Located = { column: number; card: number };

/** Where the card titled `title` sits; null when no card or several cards have that title. */
function locate(board: KanbanBoard, title: string): Located | null {
  let found: Located | null = null;
  for (const [column, col] of board.columns.entries()) {
    for (const [card, c] of col.cards.entries()) {
      if (c.title !== title) continue;
      if (found) return null;
      found = { column, card };
    }
  }
  return found;
}

function cardAt(board: KanbanBoard, at: Located): KanbanCard {
  return board.columns[at.column].cards[at.card];
}

function editFor(base: KanbanBoard, local: KanbanBoard, at: Located): CardEdit | null {
  const card = cardAt(local, at);
  const was = locate(base, card.title);
  if (!was) return null;
  const before = cardAt(base, was);
  const from = base.columns[was.column].title;
  const to = local.columns[at.column].title;
  const edit: CardEdit = {
    title: card.title,
    move: from === to ? null : { from, to },
    after: at.card > 0 ? local.columns[at.column].cards[at.card - 1].title : null,
    done: card.done === before.done ? null : card.done,
    addedBranches: card.branches.filter((b) => !before.branches.includes(b)),
  };
  return edit.move || edit.done !== null || edit.addedBranches.length > 0 ? edit : null;
}

/** Card edits that turn `base` into `local`; null when a card's title is ambiguous. */
function cardEdits(base: KanbanBoard, local: KanbanBoard): CardEdit[] | null {
  const edits: CardEdit[] = [];
  for (const [column, col] of local.columns.entries()) {
    for (const card of col.cards.keys()) {
      const at = { column, card };
      if (!locate(local, cardAt(local, at).title)) return null;
      const edit = editFor(base, local, at);
      if (edit) edits.push(edit);
    }
  }
  return edits;
}

/** Applies one edit to `board` in place; false when that would override the task's own changes. */
function applyEdit(board: KanbanBoard, edit: CardEdit): boolean {
  const at = locate(board, edit.title);
  if (!at) return false;
  const column = board.columns[at.column].title;
  // The task moved the card elsewhere too: replaying the app's move would undo the task's.
  if (edit.move && column !== edit.move.from && column !== edit.move.to) return false;
  const card = cardAt(board, at);
  if (edit.done !== null) card.done = edit.done;
  card.branches = [
    ...card.branches,
    ...edit.addedBranches.filter((b) => !card.branches.includes(b)),
  ];
  // Already in the target column: the task made the same move.
  return (
    edit.move === null || column === edit.move.to || moveTo(board, at, edit.move.to, edit.after)
  );
}

/** Moves the card at `at` into column `to`, below the card titled `after`; false when `to` is gone. */
function moveTo(board: KanbanBoard, at: Located, to: string, after: string | null): boolean {
  const target = board.columns.findIndex((col) => col.title === to);
  if (target < 0) return false;
  const [card] = board.columns[at.column].cards.splice(at.card, 1);
  const cards = board.columns[target].cards;
  const above = after === null ? -1 : cards.findIndex((c) => c.title === after);
  // A card the task removed from above it: keep the card at the column's end.
  const index = after !== null && above < 0 ? cards.length : above + 1;
  cards.splice(index, 0, card);
  return true;
}

function applyEdits(board: KanbanBoard, edits: CardEdit[]): KanbanBoard | null {
  const next = cloneBoard(board);
  return edits.every((edit) => applyEdit(next, edit)) ? next : null;
}

/**
 * Combines the app's own board edits (moving cards, ticking a card's
 * checkbox, linking task branches) with board changes a merge committed, card
 * by card, for when a line-based merge of the two clashes (#337): the task
 * edited the very card the app moved. Null unless the local board differs from
 * `base` only by such edits and every edited card is still on the merged board;
 * the caller then keeps the local text and warns.
 */
export function mergeAppBoardEdits(sides: {
  base: string;
  local: string;
  merged: string;
}): string | null {
  const base = parseKanban(sides.base);
  const local = parseKanban(sides.local);
  const edits = cardEdits(base, local);
  if (!edits) return null;
  // Any other local change (a new card, an edited description) is not ours to replay.
  const replayed = applyEdits(base, edits);
  if (!replayed || serializeKanban(replayed) !== serializeKanban(local)) return null;
  const combined = applyEdits(parseKanban(sides.merged), edits);
  return combined ? serializeKanban(combined) : null;
}

function titleCounts(markdown: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const column of parseKanban(markdown).columns) {
    for (const card of column.cards) counts.set(card.title, (counts.get(card.title) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether a line-based merge shows some card more often than both sides do:
 * the app and the task moved the same card to different columns, the lines
 * merged cleanly, and the card now sits in both.
 */
export function duplicatesCards(sides: { local: string; merged: string; result: string }): boolean {
  const local = titleCounts(sides.local);
  const merged = titleCounts(sides.merged);
  for (const [title, count] of titleCounts(sides.result)) {
    if (count > Math.max(local.get(title) ?? 0, merged.get(title) ?? 0)) return true;
  }
  return false;
}
