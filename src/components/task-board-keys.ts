import { isTaskBackgrounded } from '../store/background-tasks';
import { store, setStore } from '../store/core';
import { boardShown, boardSidePanelOpen, towardBoard } from '../store/project-pages';
import {
  focusBoardSidePanel,
  focusSidebar,
  getTaskFocusedPanel,
  navigateColumn,
  navigateRow,
  navigateTask,
  switchTaskKeepingPanel,
  unfocusPlaceholder,
  unfocusSidebar,
} from '../store/store';

export type BoardMove = 'up' | 'down' | 'left' | 'right' | 'first' | 'last';

/** Plain keys on a card; Alt+Arrows reach the board through the global bindings. */
export const BOARD_KEY_MOVES: Record<string, BoardMove> = {
  ArrowUp: 'up',
  k: 'up',
  ArrowDown: 'down',
  j: 'down',
  ArrowLeft: 'left',
  h: 'left',
  ArrowRight: 'right',
  l: 'right',
  Home: 'first',
  End: 'last',
};

/**
 * Where a move lands in a grid of columns, or undefined at the grid's edge.
 * Sideways moves keep the row, clamped to the neighbouring column's length.
 */
export function stepInGrid<T>(columns: T[][], current: T, move: BoardMove): T | undefined {
  const col = columns.findIndex((items) => items.includes(current));
  const items = columns[col];
  if (!items) return undefined;
  const row = items.indexOf(current);
  let target: T | undefined;
  if (move === 'first') target = items[0];
  else if (move === 'last') target = items.at(-1);
  else if (move === 'up' || move === 'down') target = items[row + (move === 'up' ? -1 : 1)];
  else {
    const next = columns[col + (move === 'left' ? -1 : 1)];
    target = next?.[Math.min(row, next.length - 1)];
  }
  return target === current ? undefined : target;
}

const CARD = '.task-board-title';
// Ideas aren't tasks: the keyboard and the side panel step past their lane.
const LANE = '.task-board-lane:not(.lane-ideas)';

function boardElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.task-board');
}

/**
 * A narrow board stacks its lanes (see task-board.css), so arrows walk them
 * as one column: down from a lane's last card reaches the next lane.
 */
function asShown<T>(board: HTMLElement, columns: T[][]): T[][] {
  const lanes = board.querySelector('.task-board-lanes');
  const stacked = lanes && getComputedStyle(lanes).flexDirection === 'column';
  return stacked ? [columns.flat()] : columns;
}

/** Card buttons per lane, left to right; the closed snoozed rail is a column of its own. */
function boardColumns(): HTMLElement[][] {
  const board = boardElement();
  if (!board) return [];
  return asShown(
    board,
    [...board.querySelectorAll<HTMLElement>(`${LANE}, .task-board-rail`)]
      .map((col) =>
        col.matches('.task-board-rail') ? [col] : [...col.querySelectorAll<HTMLElement>(CARD)],
      )
      .filter((items) => items.length > 0),
  );
}

/**
 * Task ids per lane, for the side panel to step through. Snoozed and minimized
 * cards are left out: showing one would end its snooze or restore it.
 */
function boardTaskColumns(): string[][] {
  const board = boardElement();
  if (!board) return [];
  return asShown(
    board,
    [...board.querySelectorAll<HTMLElement>(LANE)]
      .map((lane) =>
        [...lane.querySelectorAll<HTMLElement>('[data-board-task-id]')]
          .map((card) => card.dataset.boardTaskId ?? '')
          .filter((id) => id && !isTaskBackgrounded(id) && !store.tasks[id]?.collapsed),
      )
      .filter((ids) => ids.length > 0),
  );
}

/** The cards, the actions in the board's heading, or the filter in the title bar. */
export function boardHasFocus(): boolean {
  const active = document.activeElement;
  return !!boardElement()?.contains(active) || !!active?.closest('.task-board-search-box');
}

/** The card (or snoozed rail) holding the keyboard; a card's inner buttons count as the card. */
export function focusedBoardItem(): HTMLElement | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !boardHasFocus()) return undefined;
  if (active.matches('.task-board-rail')) return active;
  return active.closest('[data-board-card]')?.querySelector<HTMLElement>(CARD) ?? undefined;
}

/**
 * DOM focus on the board means no sidebar row, placeholder or draft has the
 * keyboard; stale flags would block Ctrl+W and deferred task focus.
 */
export function claimBoardFocus(): void {
  if (store.sidebarFocused) unfocusSidebar();
  if (store.placeholderFocused) unfocusPlaceholder();
  if (store.newTaskPanelFocused) setStore('newTaskPanelFocused', false);
  // The board's card shows the focus ring, so the task beside it must not.
  if (!store.boardFocused) setStore('boardFocused', true);
}

/** Hands the focus mark back to the task; a board unmounting with focus fires no focusout. */
export function dropBoardFocus(): void {
  if (store.boardFocused) setStore('boardFocused', false);
}

/** Drops the focus mark once DOM focus leaves the board. */
export function releaseBoardFocus(e: FocusEvent): void {
  const next = e.relatedTarget;
  if (next instanceof Element && next.closest('.task-board, .task-board-search-box')) return;
  dropBoardFocus();
}

export function focusBoardFilter(): void {
  document.querySelector<HTMLElement>('.task-board-controls .task-board-search')?.focus();
}

/** Focuses a task's card, or the first card when that task has none on the board. */
export function focusBoardCard(taskId: string | null): boolean {
  const own = taskId
    ? document.querySelector<HTMLElement>(`[data-board-task-id="${CSS.escape(taskId)}"] ${CARD}`)
    : null;
  const card = own ?? boardColumns()[0]?.[0];
  card?.focus();
  return card !== undefined;
}

/** Moves the keyboard between cards; false when the move would leave the board. */
export function moveBoardFocus(move: BoardMove): boolean {
  const current = focusedBoardItem();
  if (!current) return focusBoardCard(store.activeTaskId);
  const target = stepInGrid(boardColumns(), current, move);
  target?.focus();
  return target !== undefined;
}

function boardKeysEnabled(): boolean {
  return boardShown() && !store.showHelpDialog && !store.showSettingsDialog;
}

/** Whether the board, rather than a task's panes or the sidebar, takes the navigation keys. */
function boardTakesKeys(): boolean {
  if (boardHasFocus()) return true;
  return !store.sidebarFocused && !boardSidePanelOpen();
}

/** Whether the side panel, rather than the board or the sidebar, has the keyboard. */
function sidePanelHasKeys(): boolean {
  return boardSidePanelOpen() && !boardHasFocus() && !store.sidebarFocused;
}

type Direction = 'up' | 'down' | 'left' | 'right';

/** Moves between the shown task's panes; false at their edge in that direction. */
function moveWithinTask(direction: Direction): boolean {
  const taskId = store.activeTaskId;
  if (!taskId) return false;
  const before = getTaskFocusedPanel(taskId);
  if (direction === 'up' || direction === 'down') navigateRow(direction);
  else navigateColumn(direction);
  return store.activeTaskId !== taskId || getTaskFocusedPanel(taskId) !== before;
}

/** Shows the task of the next card that way on the board, keeping the keyboard in the panel. */
function stepSidePanel(direction: Direction): boolean {
  const current = store.activeTaskId;
  const target = current ? stepInGrid(boardTaskColumns(), current, direction) : undefined;
  if (target) switchTaskKeepingPanel(target);
  return target !== undefined;
}

/**
 * Alt+Arrows in the side panel move between the task's panes, as in a tile,
 * and past their edge on to the next card that way on the board. With no card
 * there, the edge facing the board hands the keyboard to the task's card and
 * the left edge otherwise leads to the sidebar.
 */
function navigateSidePanel(direction: Direction): void {
  if (moveWithinTask(direction) || stepSidePanel(direction)) return;
  if (direction === towardBoard()) focusBoardCard(store.activeTaskId);
  else if (direction === 'left' && store.sidebarVisible) focusSidebar();
}

/**
 * Alt+Arrows on the board, like across tiles: between cards, up to the filter
 * above the first row, past the outer lanes into the side panel on that side
 * or the sidebar. In the side panel they continue past its task's panes on to
 * the board's cards. Returns whether the board handled the keys.
 */
export function navigateBoard(direction: Direction): boolean {
  if (!boardKeysEnabled()) return false;
  if (sidePanelHasKeys()) {
    // A draft is not on the board; its own navigation leads back to it.
    if (store.showNewTaskPanel) return false;
    navigateSidePanel(direction);
    return true;
  }
  if (!boardTakesKeys()) return false;
  if (moveBoardFocus(direction)) return true;
  if (direction === 'up') focusBoardFilter();
  else if (boardSidePanelOpen() && direction === (store.boardSidePanelLeft ? 'left' : 'right')) {
    focusBoardSidePanel();
  } else if (direction === 'left' && store.sidebarVisible) focusSidebar();
  return true;
}

/**
 * Previous/next task on the board, or the one above/below in its lane. On the
 * board itself the keyboard steps through cards, sideways in reading order; in
 * the side panel it switches the task shown there in the same order, skipping
 * snoozed and minimized ones since showing one ends its snooze or restores it. Either way, the keyboard
 * stays where it is: the side panel's panes don't come in between.
 */
export function navigateBoardTask(direction: Direction): boolean {
  if (!boardKeysEnabled()) return false;
  const sideways = direction === 'left' || direction === 'right';
  // From the sidebar too: with no side panel, switching tasks would close the board.
  if (!sidePanelHasKeys()) {
    if (!sideways) {
      moveBoardFocus(direction);
      return true;
    }
    const cards = boardColumns().flat();
    const current = focusedBoardItem();
    if (current) cards[cards.indexOf(current) + (direction === 'left' ? -1 : 1)]?.focus();
    else focusBoardCard(store.activeTaskId);
    return true;
  }
  if (store.newTaskPanelFocused) return true;
  if (sideways) navigateTask(direction, boardTaskColumns().flat());
  else stepSidePanel(direction);
  return true;
}
