import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { clearAgentActivity, markAgentOutput } from '../store/taskStatus';
import { closeTerminal, createTerminal } from '../store/terminals';
import type { Task } from '../store/types';
import { setBoardQuery } from './BoardSearch';
import { openBesideBoard } from './board/TaskStatus';
import { TaskBoard } from './TaskBoard';
import { WORKING_HOLD_MS } from './task-board-hold';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => ({})) }));

// What TerminalPanel forwards from the dev server's terminal.
const print = () =>
  markAgentOutput('agent-dev', new TextEncoder().encode('Compiling...\r\n'), 'term-dev');

function task(id: string, name: string): Task {
  return {
    id,
    name,
    projectId: 'web',
    branchName: id,
    worktreePath: `/repo/${id}`,
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
  };
}

let host: HTMLDivElement;
let dispose: () => void;
const lane = (title: string) =>
  [...host.querySelectorAll('.task-board-lane')].find((el) =>
    el.querySelector('h3')?.textContent?.startsWith(title),
  );
const cardNames = (title: string) =>
  [...(lane(title)?.querySelectorAll('.task-board-name') ?? [])].map((el) => el.textContent);
const terminalCard = (name: string) =>
  [...host.querySelectorAll<HTMLElement>('.task-board-terminal-card')].find(
    (el) => el.querySelector('.task-board-name')?.textContent === name,
  );

beforeEach(() => {
  setStore('tasks', reconcile({ docs: task('docs', 'Update docs') }));
  setStore(
    'terminals',
    reconcile({
      'term-dev': { id: 'term-dev', name: 'Dev server', agentId: 'agent-dev' },
      'term-scratch': { id: 'term-scratch', name: 'Scratch', agentId: 'agent-scratch' },
    }),
  );
  setStore('projects', [{ id: 'web', name: 'Website', path: '/repo', color: '#0af' }]);
  setStore('taskOrder', ['term-scratch', 'docs', 'term-dev']);
  setStore('collapsedTaskOrder', []);
  setStore('taskProjectFilter', null);
  setStore('activeTaskId', 'docs');
  setStore('boardView', true);
  setStore('boardPeek', false);
  setStore('showNewTaskPanel', false);
  host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <TaskBoard />, host);
  print();
});

afterEach(() => {
  clearAgentActivity('agent-dev');
  dispose();
  document.body.replaceChildren();
  setBoardQuery('');
  setStore('terminals', reconcile({}));
  setStore('taskOrder', []);
});

it('lists terminals in their own lane, in sidebar order, out of the task lanes', () => {
  expect(cardNames('Terminals')).toEqual(['Scratch', 'Dev server']);
  expect(cardNames('Working')).toEqual([]);
  expect(cardNames('Stopped')).toEqual(['Update docs']);
  expect(lane('Terminals')?.querySelector('.task-board-count')?.textContent).toBe('2');
});

it('says whether each terminal is printing', () => {
  expect(terminalCard('Dev server')?.textContent).toContain('Running');
  expect(terminalCard('Scratch')?.textContent).toContain('Idle');
});

it('goes idle a moment after the terminal stops printing', () => {
  vi.useFakeTimers();
  try {
    // Restart the activity under fake timers.
    clearAgentActivity('agent-dev');
    print();
    expect(terminalCard('Dev server')?.textContent).toContain('Running');
    // Quiet long enough to count as idle, then held like a task card.
    vi.advanceTimersByTime(15_000);
    expect(terminalCard('Dev server')?.textContent).toContain('Running');
    vi.advanceTimersByTime(WORKING_HOLD_MS);
    expect(terminalCard('Dev server')?.textContent).toContain('Idle');
  } finally {
    vi.useRealTimers();
  }
});

it('sits after the task lanes', () => {
  const titles = [...host.querySelectorAll('.task-board-lane h3')].map((el) =>
    el.firstChild?.textContent?.trim(),
  );
  expect(titles.at(-1)).toBe('Terminals');
});

it('hides the lane without terminals', () => {
  setStore('terminals', reconcile({}));
  expect(lane('Terminals')).toBeUndefined();
});

it('opens a terminal in the side panel and keeps the board', () => {
  terminalCard('Scratch')?.querySelector('button')?.click();
  expect(store.boardView).toBe(true);
  expect(store.boardPeek).toBe(true);
  expect(store.activeTaskId).toBe('term-scratch');
  expect(terminalCard('Scratch')?.classList.contains('shown')).toBe(true);
});

it('filters terminals by the board search and hides closing ones', () => {
  setStore('terminals', 'term-dev', 'closingStatus', 'closing');
  expect(terminalCard('Dev server')).toBeUndefined();
  setBoardQuery('scr');
  expect(cardNames('Terminals')).toEqual(['Scratch']);
});

it('still says why the task lanes are empty while terminals are open', () => {
  setStore('tasks', reconcile({}));
  setStore('taskProjectFilter', 'web');
  expect(host.querySelector('.task-board-empty')?.textContent).toContain(
    'No running tasks in Website',
  );
  expect(cardNames('Terminals')).toEqual(['Scratch', 'Dev server']);
});

it('opens a terminal created from the board in its side panel', () => {
  openBesideBoard(null, createTerminal);
  const created = store.activeTaskId ?? '';
  expect(store.terminals[created]).toBeDefined();
  expect(store.boardView).toBe(true);
  expect(store.boardPeek).toBe(true);
});

it('closes the side panel at once when its terminal closes and hands the keyboard to the board', async () => {
  terminalCard('Scratch')?.querySelector('button')?.click();
  const closing = closeTerminal('term-scratch');
  // At once, not after the process is killed.
  expect(store.boardPeek).toBe(false);
  await closing;
  expect(store.boardView).toBe(true);
  // The neighbour's card, so the board's arrow keys keep working.
  expect(
    document.activeElement?.closest('[data-board-card]')?.getAttribute('data-board-card'),
  ).toBe('docs');
  // Let the removal finish so it cannot touch the next test's store.
  await vi.waitFor(() => expect(store.terminals['term-scratch']).toBeUndefined());
});

it('keeps the side panel when another terminal closes', async () => {
  terminalCard('Scratch')?.querySelector('button')?.click();
  await closeTerminal('term-dev');
  expect(store.boardPeek).toBe(true);
  expect(store.activeTaskId).toBe('term-scratch');
  await vi.waitFor(() => expect(store.terminals['term-dev']).toBeUndefined());
});
