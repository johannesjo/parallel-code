import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { WorkspaceControls } from './WorkspaceControls';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => ({})) }));

let dispose: () => void;

function boardButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('[aria-label^="Board:"]');
  if (!button) throw new Error('missing board button');
  return button;
}

beforeEach(() => {
  setStore('boardView', true);
  setStore('boardPeek', true);
  setStore('showNewTaskPanel', false);
  setStore('githubIssuesProjectId', null);
  const root = document.createElement('div');
  document.body.append(root);
  dispose = render(() => <WorkspaceControls />, root);
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
});

it('closes the task open beside the board, keeping the board', () => {
  boardButton().click();
  expect(store.boardPeek).toBe(false);
  expect(store.boardView).toBe(true);
});

it('leaves a draft beside the board to its own Cancel', () => {
  setStore('showNewTaskPanel', true);
  boardButton().click();
  expect(store.boardPeek).toBe(true);
  expect(store.boardView).toBe(true);
});
