import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withViewTransition } from '../lib/viewTransition';
import { setStore, store } from '../store/core';
import { boardSidePanelOpen } from '../store/project-pages';
import { getPanelUserSize } from '../store/ui';
import {
  BoardSidePanelClose,
  BoardSidePanelHandle,
  boardSidePanelBasis,
  closeSidePanel,
} from './BoardSidePanel';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => ({})) }));

let dispose: () => void;
let handle: HTMLElement;

function withWidth(el: HTMLElement, width: number): HTMLElement {
  el.getBoundingClientRect = () => ({ width }) as DOMRect;
  return el;
}

function drag(fromX: number, toX: number): void {
  handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: fromX, bubbles: true }));
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: toX }));
  window.dispatchEvent(new MouseEvent('mouseup'));
}

beforeEach(() => {
  setStore('panelUserSize', {});
  setStore('boardSidePanelLeft', false);
  const board = withWidth(document.createElement('section'), 800);
  board.className = 'task-board';
  const panel = withWidth(document.createElement('div'), 500);
  document.body.append(board, panel);
  dispose = render(() => <BoardSidePanelHandle />, panel);
  const el = panel.querySelector<HTMLElement>('.board-side-panel-handle');
  if (!el) throw new Error('missing handle');
  handle = el;
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
});

it('widens the side panel when its left edge is dragged left', () => {
  drag(1000, 900);
  expect(getPanelUserSize('board:side-panel')).toBe(600);
  expect(boardSidePanelBasis()).toBe('600px');
});

it("mirrors resizing for a panel on the board's left", () => {
  setStore('boardSidePanelLeft', true);
  drag(1000, 1100);
  expect(getPanelUserSize('board:side-panel')).toBe(600);
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(getPanelUserSize('board:side-panel')).toBe(524);
});

it('keeps both the panel and the board at a usable width', () => {
  drag(1000, 0);
  // 500 + 800 board - 320 the board keeps
  expect(getPanelUserSize('board:side-panel')).toBe(980);
  drag(1000, 1900);
  expect(getPanelUserSize('board:side-panel')).toBe(360);
});

it('stops resizing on mouseup and resets on double-click', () => {
  drag(1000, 900);
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 }));
  expect(getPanelUserSize('board:side-panel')).toBe(600);
  handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  expect(boardSidePanelBasis()).toBeUndefined();
});

it('resizes from the keyboard within the same bounds', () => {
  const press = (key: string) =>
    handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  expect(handle.getAttribute('role')).toBe('separator');
  press('ArrowLeft');
  expect(getPanelUserSize('board:side-panel')).toBe(524);
  press('ArrowRight');
  expect(getPanelUserSize('board:side-panel')).toBe(476);
});

it('leaves a draft to its own Cancel, which asks before discarding', () => {
  setStore('boardView', true);
  setStore('boardPeek', true);
  setStore('showNewTaskPanel', true);
  const bar = document.createElement('div');
  document.body.append(bar);
  const disposeBar = render(() => <BoardSidePanelClose />, bar);
  expect(bar.querySelector('[aria-label="Close side panel"]')).toBeNull();
  // Escape from the board hides the peeked task but keeps the draft.
  closeSidePanel();
  expect(store.showNewTaskPanel).toBe(true);
  expect(boardSidePanelOpen()).toBe(true);
  disposeBar();
});

it('reports its width range to assistive tech', () => {
  handle.dispatchEvent(new FocusEvent('focus'));
  expect(handle.getAttribute('aria-valuenow')).toBe('500');
  expect(handle.getAttribute('aria-valuemin')).toBe('360');
  expect(handle.getAttribute('aria-valuemax')).toBe('980');
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  expect(handle.getAttribute('aria-valuenow')).toBe('524');
});

it('reports the reset width after a double-click', () => {
  handle.dispatchEvent(new FocusEvent('focus'));
  // The reset falls back to the CSS default width.
  withWidth(handle.parentElement as HTMLElement, 420);
  handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  expect(handle.getAttribute('aria-valuenow')).toBe('420');
});

function deferViewTransitions(): (() => void)[] {
  const pending: (() => void)[] = [];
  const start = vi.fn((update: () => void) => {
    pending.push(update);
    return { ready: Promise.resolve(), finished: Promise.resolve() };
  });
  Object.defineProperty(document, 'startViewTransition', { value: start, configurable: true });
  return pending;
}

function addCard(id: string): HTMLButtonElement | null {
  const card = document.createElement('li');
  card.dataset.boardCard = id;
  card.dataset.boardTaskId = id;
  card.innerHTML = `<button class="task-board-title">${id}</button>`;
  document.body.append(card);
  return card.querySelector('button');
}

it('closes the side panel only when the view transition runs its update', () => {
  const pending = deferViewTransitions();
  const button = addCard('pr');
  setStore('activeTaskId', 'pr');
  setStore('boardView', true);
  setStore('boardPeek', true);
  try {
    closeSidePanel();
    // The old layout is captured first, so nothing has changed yet.
    expect(store.boardPeek).toBe(true);
    pending.forEach((update) => update());
    expect(store.boardPeek).toBe(false);
    expect(document.activeElement).toBe(button);
  } finally {
    Reflect.deleteProperty(document, 'startViewTransition');
  }
});

it('returns focus to the card of a task opened while the close was pending', () => {
  const pending = deferViewTransitions();
  addCard('a');
  const b = addCard('b');
  setStore('activeTaskId', 'a');
  setStore('boardView', true);
  setStore('boardPeek', true);
  try {
    // A second card click whose update has not run yet, then Escape.
    withViewTransition(() => setStore('activeTaskId', 'b'));
    closeSidePanel();
    pending.forEach((update) => update());
    expect(document.activeElement).toBe(b);
  } finally {
    Reflect.deleteProperty(document, 'startViewTransition');
  }
});
