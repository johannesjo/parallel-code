import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import type { Project } from '../store/types';
import { setBoardQuery } from './BoardSearch';
import { TaskBoard } from './TaskBoard';
import { navigateBoardTask } from './task-board-keys';

const { openDocumentWorkspace } = vi.hoisted(() => ({ openDocumentWorkspace: vi.fn() }));
vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock('../documents/store', () => ({ openDocumentWorkspace }));

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

beforeEach(() => {
  openDocumentWorkspace.mockReset();
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
  setStore('activeDocumentProjectId', null);
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

it('turns the terminals lane into Terminals & docs while document projects exist', () => {
  expect(laneTitles().at(-1)).toBe('Terminals & docs');
  expect(cardNames('Terminals & docs')).toEqual(['Dev server', 'Sync spec', 'Storage ADR']);
  expect(lane('Terminals & docs')?.querySelector('.task-board-count')?.textContent).toBe('3');
});

it('keeps the plain Terminals lane while document workspaces are off', () => {
  setStore('documentWorkspacesEnabled', false);
  expect(cardNames('Terminals')).toEqual(['Dev server']);
  expect(docCard('Sync spec')).toBeUndefined();
});

it('shows a Docs lane when documents are open without terminals', () => {
  setStore('terminals', reconcile({}));
  setStore('taskOrder', []);
  expect(cardNames('Docs')).toEqual(['Sync spec', 'Storage ADR']);
});

it('leaves out documents whose folder is missing and filters by the board search', () => {
  setStore('missingProjectIds', { adr: true });
  expect(docCard('Storage ADR')).toBeUndefined();
  setBoardQuery('sync');
  expect(cardNames('Terminals & docs')).toEqual(['Sync spec']);
});

it('opens a document in the side panel and keeps the board', () => {
  docCard('Storage ADR')?.querySelector('button')?.click();
  expect(openDocumentWorkspace).toHaveBeenCalledWith('adr');
  expect(store.boardView).toBe(true);
  expect(store.boardPeek).toBe(true);
});

it('marks the open document', () => {
  setStore('activeDocumentProjectId', 'spec');
  expect(docCard('Sync spec')?.textContent).toContain('Open');
  expect(docCard('Storage ADR')?.textContent).toContain('Document');
});

it('steps the side panel past documents that are not open', () => {
  setStore('activeDocumentProjectId', 'adr');
  setStore('boardPeek', true);
  setStore('activeTaskId', 'term-dev');
  (document.activeElement as HTMLElement | null)?.blur();
  navigateBoardTask('right');
  expect(store.activeTaskId).toBe('doc-agent-adr');
});
