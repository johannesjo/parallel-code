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
  host = document.createElement('div');
  document.body.append(host);
  const [isOpen, setOpen] = createSignal(true);
  open = isOpen;
  dispose = render(() => <TaskSwitcher open={isOpen()} onClose={() => setOpen(false)} />, host);
});

afterEach(() => {
  dispose();
  document.body.replaceChildren();
});

it('lists open tasks with their project and branch', () => {
  expect(options().map((o) => o.textContent)).toEqual([
    'Fix loginapi · task/login',
    'Dark modeweb · task/dark',
    'Login copyweb · task/copy',
  ]);
});

it('filters by name and project, moves the selection with arrows and activates on Enter', () => {
  type('login');
  expect(options()).toHaveLength(2);
  press('ArrowDown');
  expect(options()[1].getAttribute('aria-selected')).toBe('true');
  expect(input()?.getAttribute('aria-activedescendant')).toBe(options()[1].id);
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
  expect(document.body.textContent).toContain('No open task matches.');
  press('Enter');
  expect(store.activeTaskId).toBe('login');
});

it('activates a task on click', () => {
  options()[1].click();
  expect(store.activeTaskId).toBe('dark');
  expect(open()).toBe(false);
});

it('keeps a valid selection when the highlighted task closes while open', () => {
  press('ArrowUp');
  expect(options()[2].getAttribute('aria-selected')).toBe('true');
  setStore('taskOrder', ['login', 'dark']);
  expect(options()[1].getAttribute('aria-selected')).toBe('true');
  expect(input()?.getAttribute('aria-activedescendant')).toBe(options()[1].id);
  press('Enter');
  expect(store.activeTaskId).toBe('dark');
});
