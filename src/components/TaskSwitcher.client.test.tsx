import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import type { Task } from '../store/types';
import { TaskSwitcher } from './TaskSwitcher';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => ({})) }));

function task(id: string, name: string, projectId: string): Task {
  return {
    id,
    name,
    projectId,
    branchName: `task/${id}`,
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
let open: () => boolean;
const ran: string[] = [];
let focusedOnRun: Element | null = null;
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const actions = [
  {
    id: 'finishTask',
    name: 'Finish task',
    detail: 'Fix login',
    shortcut: 'Ctrl + Shift + M',
    keywords: 'merge',
  },
  { id: 'toggleSidebar', name: 'Toggle sidebar', detail: '', shortcut: 'Ctrl + B' },
  { id: 'zoomIn', name: 'Zoom in', detail: '', shortcut: '' },
];
const names = () => options().map((o) => o.querySelector('.task-switcher-name')?.textContent);

const input = () => document.querySelector<HTMLInputElement>('.task-switcher-input');
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const type = (value: string) => {
  const el = input();
  if (!el) throw new Error('switcher input missing');
  el.value = value;
  el.dispatchEvent(new InputEvent('input', { bubbles: true }));
};
const press = (key: string) =>
  input()?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

beforeEach(() => {
  setStore(
    'tasks',
    reconcile({
      login: task('login', 'Fix login', 'api'),
      dark: task('dark', 'Dark mode', 'web'),
      copy: task('copy', 'Login copy', 'web'),
    }),
  );
  setStore('projects', [
    { id: 'api', name: 'api', path: '/api', color: '#fff' },
    { id: 'web', name: 'web', path: '/web', color: '#fff' },
  ]);
  setStore('taskOrder', ['login', 'dark', 'copy']);
  setStore('activeTaskId', 'login');
  setStore('activeDocumentProjectId', null);
  localStorage.clear();
  ran.length = 0;
  mount();
});

// A fresh switcher, as after an app restart: only saved state carries over.
function mount(): void {
  host = document.createElement('div');
  document.body.append(host);
  const [isOpen, setOpen] = createSignal(true);
  open = isOpen;
  dispose = render(
    () => (
      <TaskSwitcher
        open={isOpen()}
        onClose={() => setOpen(false)}
        actions={actions}
        onAction={(id) => {
          ran.push(id);
          focusedOnRun = document.activeElement;
        }}
      />
    ),
    host,
  );
}

afterEach(() => {
  dispose();
  document.body.replaceChildren();
});

it('lists open tasks with their project and branch, then actions with their shortcut', () => {
  expect(options().map((o) => o.textContent)).toEqual([
    'Fix loginapi · task/login',
    'Dark modeweb · task/dark',
    'Login copyweb · task/copy',
    'Finish taskFix loginCtrl + Shift + M',
    'Toggle sidebarCtrl + B',
    'Zoom in',
  ]);
});

it('lists tasks grouped by project, like the sidebar and the tiles', () => {
  dispose();
  setStore('projects', [
    { id: 'web', name: 'web', path: '/web', color: '#fff' },
    { id: 'api', name: 'api', path: '/api', color: '#fff' },
  ]);
  setStore('tasks', 'other', task('other', 'Other web task', 'web'));
  setStore('taskOrder', ['dark', 'login', 'other', 'copy']);
  mount();
  expect(names().slice(0, 4)).toEqual(['Dark mode', 'Other web task', 'Login copy', 'Fix login']);
});

it('runs an action on Enter after closing, and finds actions by name only', async () => {
  type('ctrl');
  expect(options()).toHaveLength(0);
  type('sidebar');
  press('Enter');
  expect(open()).toBe(false);
  await nextFrame();
  expect(ran).toEqual(['toggleSidebar']);
  expect(store.activeTaskId).toBe('login');
});

it('narrows to actions on a leading ">", keeping selection ids in step', async () => {
  type('>');
  expect(names()).toEqual(['Finish task', 'Toggle sidebar', 'Zoom in']);
  press('ArrowDown');
  expect(input()?.getAttribute('aria-activedescendant')).toBe(options()[1].id);
  options()[2].click();
  await nextFrame();
  expect(ran).toEqual(['zoomIn']);
});

it('filters by name and project, moves the selection with arrows and activates on Enter', () => {
  type('login');
  // A name starting with the query ranks above one that only contains it.
  expect(names()).toEqual(['Login copy', 'Fix login']);
  press('ArrowDown');
  expect(options()[1].getAttribute('aria-selected')).toBe('true');
  expect(input()?.getAttribute('aria-activedescendant')).toBe(options()[1].id);
  press('ArrowUp');
  press('Enter');
  expect(store.activeTaskId).toBe('copy');
  expect(open()).toBe(false);
});

it('narrows by every word and says when nothing matches', () => {
  type('login web');
  expect(options().map((o) => o.querySelector('.task-switcher-name')?.textContent)).toEqual([
    'Login copy',
  ]);
  type('nothing like this');
  expect(options()).toHaveLength(0);
  expect(document.body.textContent).toContain('No task or action matches.');
  press('Enter');
  expect(store.activeTaskId).toBe('login');
});

it('activates a task on click', () => {
  options()[1].click();
  expect(store.activeTaskId).toBe('dark');
  expect(open()).toBe(false);
});

it('keeps a valid selection when the highlighted task closes while open', () => {
  // Matches the tasks' branches only, so the last row is a task, not an action.
  type('task/');
  press('ArrowUp');
  expect(options()[2].getAttribute('aria-selected')).toBe('true');
  setStore('taskOrder', ['login', 'dark']);
  expect(options()[1].getAttribute('aria-selected')).toBe('true');
  expect(input()?.getAttribute('aria-activedescendant')).toBe(options()[1].id);
  press('Enter');
  expect(store.activeTaskId).toBe('dark');
});

it("shows an action's target task without matching on it, and finds actions by keyword", () => {
  type('fix login');
  expect(names()).toEqual(['Fix login']);
  type('merge');
  expect(names()).toEqual(['Finish task']);
});

it('lists the last-run actions first, also after a restart', async () => {
  type('>');
  options()[2].click();
  await nextFrame();
  expect(ran).toEqual(['zoomIn']);
  dispose();
  document.body.replaceChildren();
  mount();
  type('>');
  expect(names()).toEqual(['Zoom in', 'Finish task', 'Toggle sidebar']);
});

it('runs an action once focus is back where the switcher was opened from', async () => {
  dispose();
  document.body.replaceChildren();
  const terminal = document.createElement('button');
  document.body.append(terminal);
  terminal.focus();
  mount();
  await nextFrame();
  type('zoom');
  press('Enter');
  await nextFrame();
  expect(ran).toEqual(['zoomIn']);
  expect(focusedOnRun).toBe(terminal);
});
