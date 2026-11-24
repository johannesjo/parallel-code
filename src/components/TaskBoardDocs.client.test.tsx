import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import type { Project } from '../store/types';
import { setBoardQuery } from './BoardSearch';
import { TaskBoard } from './TaskBoard';
import { navigateBoardTask } from './task-board-keys';

const { openDocumentWorkspace, closeDocumentWorkspace } = vi.hoisted(() => ({
  openDocumentWorkspace: vi.fn(),
  closeDocumentWorkspace: vi.fn(),
}));
vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock('../documents/store', () => ({ openDocumentWorkspace, closeDocumentWorkspace }));

function docProject(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/notes/${id}`,
    color: '#0af',
    kind: 'document',
    documentPath: `${id}.md`,
  };
}

let host: HTMLDivElement;
let dispose: () => void;
const laneTitles = () =>
  [...host.querySelectorAll('.task-board-lane h3')].map((el) => el.firstChild?.textContent?.trim());
const lane = (title: string) =>
  [...host.querySelectorAll('.task-board-lane')].find(
    (el) => el.querySelector('h3')?.firstChild?.textContent?.trim() === title,
  );
const cardNames = (title: string) =>
  [...(lane(title)?.querySelectorAll('.task-board-name') ?? [])].map((el) => el.textContent);
const docCard = (name: string) =>
  [...host.querySelectorAll<HTMLElement>('.task-board-doc-card')].find(
    (el) => el.querySelector('.task-board-name')?.textContent === name,
  );

const pickFromMenu = (name: string, label: string) => {
  docCard(name)?.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }),
  );
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((item) => item.textContent?.trim() === label)
    ?.click();
};

beforeEach(() => {
  openDocumentWorkspace.mockReset();
  closeDocumentWorkspace.mockReset();
  closeDocumentWorkspace.mockImplementation(() => setStore('activeDocumentProjectId', null));
  setStore('tasks', reconcile({}));
  setStore(
    'terminals',
    reconcile({ 'term-dev': { id: 'term-dev', name: 'Dev server', agentId: 'agent-dev' } }),
  );
  setStore('projects', [
    { id: 'web', name: 'Website', path: '/repo', color: '#0af' },
    docProject('spec', 'Sync spec'),
    docProject('adr', 'Storage ADR'),
  ]);
  setStore('missingProjectIds', reconcile({}));
  setStore('documentWorkspacesEnabled', true);
  setStore('activeDocumentProjectId', 'spec');
  setStore('taskOrder', ['term-dev']);
  setStore('collapsedTaskOrder', []);
  setStore('taskProjectFilter', null);
  setStore('activeTaskId', null);
  setStore('boardView', true);
  setStore('boardPeek', false);
  setStore('showNewTaskPanel', false);
  host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <TaskBoard />, host);
});

afterEach(() => {
  dispose();
  document.body.replaceChildren();
  setBoardQuery('');
  setStore('terminals', reconcile({}));
  setStore('taskOrder', []);
  setStore('projects', []);
  setStore('documentWorkspacesEnabled', false);
});

it('turns the terminals lane into Terminals & docs while a document is open', () => {
  expect(laneTitles().at(-1)).toBe('Terminals & docs');
  expect(cardNames('Terminals & docs')).toEqual(['Dev server', 'Sync spec']);
  expect(lane('Terminals & docs')?.querySelector('.task-board-count')?.textContent).toBe('2');
});

it('leaves minimized documents off the board', () => {
  setStore('activeDocumentProjectId', null);
  expect(cardNames('Terminals')).toEqual(['Dev server']);
  expect(docCard('Sync spec')).toBeUndefined();
  expect(docCard('Storage ADR')).toBeUndefined();
});

it('keeps the plain Terminals lane while document workspaces are off', () => {
  setStore('documentWorkspacesEnabled', false);
  expect(cardNames('Terminals')).toEqual(['Dev server']);
  expect(docCard('Sync spec')).toBeUndefined();
});

it('shows a Docs lane when a document is open without terminals', () => {
  setStore('terminals', reconcile({}));
  setStore('taskOrder', []);
  expect(cardNames('Docs')).toEqual(['Sync spec']);
});

it('hides the lane once its only document is minimized', () => {
  setStore('terminals', reconcile({}));
  setStore('taskOrder', []);
  setStore('activeDocumentProjectId', null);
  expect(lane('Docs')).toBeUndefined();
});

it('leaves out a document whose folder is missing and filters by the board search', () => {
  setStore('missingProjectIds', { spec: true });
  expect(docCard('Sync spec')).toBeUndefined();
  setStore('missingProjectIds', reconcile({}));
  setBoardQuery('adr');
  expect(docCard('Sync spec')).toBeUndefined();
  setBoardQuery('sync');
  expect(cardNames('Terminals & docs')).toEqual(['Sync spec']);
});

it('opens the document in the side panel and keeps the board', () => {
  docCard('Sync spec')?.querySelector('button')?.click();
  expect(openDocumentWorkspace).toHaveBeenCalledWith('spec');
  expect(store.boardView).toBe(true);
  expect(store.boardPeek).toBe(true);
});

it('opens the document from its right-click menu', () => {
  pickFromMenu('Sync spec', 'Open');
  expect(openDocumentWorkspace).toHaveBeenCalledWith('spec');
  expect(store.boardPeek).toBe(true);
});

it('minimizes the document from its right-click menu', () => {
  pickFromMenu('Sync spec', 'Minimize');
  expect(closeDocumentWorkspace).toHaveBeenCalled();
  expect(docCard('Sync spec')).toBeUndefined();
});

it('steps the side panel onto the open document', () => {
  setStore('boardPeek', true);
  setStore('activeTaskId', 'term-dev');
  (document.activeElement as HTMLElement | null)?.blur();
  navigateBoardTask('right');
  expect(store.activeTaskId).toBe('doc-agent-spec');
});

it('opens the document on the other side from its menu, without the card click', () => {
  setStore('boardSidePanelLeft', false);
  pickFromMenu('Sync spec', 'Open on the left');
  expect(store.boardSidePanelLeft).toBe(true);
  expect(store.boardPeek).toBe(true);
  // Opened once by the menu; a click reaching the card would open it again.
  expect(openDocumentWorkspace).toHaveBeenCalledTimes(1);
  setStore('boardSidePanelLeft', false);
});
