import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { TaskTitleBar } from './TaskTitleBar';
import { store, setStore } from '../store/core';
import {
  bringTaskToFront,
  getTaskSnoozedUntil,
  isTaskBackgrounded,
} from '../store/background-tasks';
import { invoke } from '../lib/ipc';
import type { Task } from '../store/types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));

const task: Task = {
  id: 'one',
  name: 'one',
  projectId: 'project',
  branchName: 'one',
  worktreePath: '/tmp/one',
  agentIds: [],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
  baseBranch: 'main',
};

let container: HTMLDivElement;
let dispose: () => void;
const [pushing, setPushing] = createSignal(false);
const [pushSuccess, setPushSuccess] = createSignal(false);
const onFinish = vi.fn();

beforeEach(() => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  bringTaskToFront('one');
  setStore('collapsedTaskOrder', []);
  setStore('tasks', reconcile({ one: { ...task } }));
  setStore('taskOrder', ['one']);
  setStore('focusMode', false);
  setPushing(false);
  setPushSuccess(false);
  onFinish.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  dispose = render(
    () => (
      <TaskTitleBar
        task={store.tasks.one}
        isActive
        onClose={() => undefined}
        onFinish={onFinish}
        pushing={pushing()}
        pushSuccess={pushSuccess()}
        onTitleEditRef={() => undefined}
      />
    ),
    container,
  );
});

afterEach(() => {
  dispose();
  container.remove();
});

const button = (name: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  );

it('offers Finish as a labelled action that reflects push progress', () => {
  const finish = button('Finish');
  expect(finish?.title).toBe('Finish: merge into main or push');
  finish?.click();
  expect(onFinish).toHaveBeenCalledOnce();

  setPushing(true);
  expect(finish?.textContent).toBe('Pushing…');
  setPushing(false);
  setPushSuccess(true);
  expect(finish?.textContent).toBe('Pushed');
  expect(finish?.dataset.state).toBe('pushed');
});

it('exposes canvas and focus as named toggles', () => {
  const canvas = button('Open canvas');
  expect(canvas?.getAttribute('aria-pressed')).toBe('false');
  canvas?.click();
  expect(canvas?.getAttribute('aria-pressed')).toBe('true');
  expect(canvas?.getAttribute('aria-label')).toBe('Close canvas');

  expect(button('Focus on this task')?.getAttribute('aria-pressed')).toBe('false');
  setStore('focusMode', true);
  expect(button('Exit focus mode')?.getAttribute('aria-pressed')).toBe('true');
});

it('keeps plain actions free of toggle state', () => {
  for (const name of ['Later', 'Close task']) {
    const b = button(name);
    expect(b).toBeDefined();
    expect(b?.hasAttribute('aria-pressed')).toBe(false);
  }
});

const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === label,
  );

it('groups snooze and minimize, and offers restore for a backgrounded task', () => {
  expect(button('Collapse task')).toBeUndefined();
  expect(button('Send task to back until new activity')).toBeUndefined();
  button('Later')?.click();
  expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Later');
  expect(menuItem('Minimize (stop agents)')).toBeDefined();
  menuItem('Snooze until new activity')?.click();
  expect(isTaskBackgrounded('one')).toBe(true);
  expect(document.querySelector('[role="menu"]')).toBeNull();

  button('Later')?.click();
  menuItem('Restore to front')?.click();
  expect(isTaskBackgrounded('one')).toBe(false);
});

it('minimizes through the existing collapse action', async () => {
  button('Later')?.click();
  menuItem('Minimize (stop agents)')?.click();
  await vi.waitFor(() => expect(store.tasks.one.collapsed).toBe(true));
  expect(store.collapsedTaskOrder).toEqual(['one']);
});

it.each([{ coordinatorMode: true }, { delegationParent: true }, { coordinatedBy: 'parent' }])(
  'does not offer minimize for managed tasks: %j',
  (fields) => {
    setStore('tasks', 'one', fields);
    button('Later')?.click();
    expect(menuItem('Minimize (stop agents)')).toBeUndefined();
    expect(menuItem('Snooze until new activity')).toBeDefined();
  },
);

it('dismisses Later with Escape or an outside click', () => {
  const trigger = button('Later');
  trigger?.focus();
  trigger?.click();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);

  trigger?.click();
  document.querySelector<HTMLElement>('.chat-menu-backdrop')?.click();
  expect(trigger?.getAttribute('aria-expanded')).toBe('false');
});

it('orders task decisions, view controls, and close', () => {
  const labels = [...container.querySelectorAll('.task-title-actions button')].map(
    (item) => item.getAttribute('aria-label') ?? item.textContent?.trim(),
  );
  expect(labels).toEqual(['Finish', 'Later', 'Open canvas', 'Focus on this task', 'Close task']);
});

it('offers running snooze presets directly in a submenu without a dialog', () => {
  button('Later')?.click();
  const mode = menuItem('Snooze · keep running');
  expect(mode?.getAttribute('aria-haspopup')).toBe('menu');
  mode?.click();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(2);
  expect(
    [...document.querySelectorAll('[role="menu"][aria-label="Snooze · keep running"] button')].map(
      (item) => item.textContent?.trim(),
    ),
  ).toEqual(['15 minutes', '30 minutes', '1 hour', '2 hours', '4 hours', '8 hours']);
  const now = Date.now();
  menuItem('15 minutes')?.click();
  expect(getTaskSnoozedUntil('one')).toBeGreaterThanOrEqual(now + 0.25 * 3_600_000);
  expect(store.tasks.one.collapsed).not.toBe(true);
  expect(container.textContent).toContain('Snoozed until');
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('offers longer presets for stopping agents while snoozed', async () => {
  button('Later')?.click();
  menuItem('Snooze · stop agents')?.click();
  expect(
    [...document.querySelectorAll('[role="menu"][aria-label="Snooze · stop agents"] button')].map(
      (item) => item.textContent?.trim(),
    ),
  ).toEqual(['1 hour', '4 hours', '8 hours', '1 day', '3 days', '1 week']);
  const now = Date.now();
  menuItem('3 days')?.click();
  await vi.waitFor(() => expect(store.tasks.one.collapsed).toBe(true));
  expect(store.tasks.one.snoozedUntil).toBeGreaterThanOrEqual(now + 72 * 3_600_000);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('disables the stop-agents submenu for coordinated tasks', () => {
  setStore('tasks', 'one', 'coordinatorMode', true);
  button('Later')?.click();
  const mode = menuItem('Snooze · stop agents');
  expect(mode?.disabled).toBe(true);
  expect(mode?.title).toBe('Coordinated tasks need to keep their agents running.');
  mode?.click();
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
});

it('opens presets on hover and switches between the two modes', () => {
  button('Later')?.click();
  menuItem('Snooze · keep running')?.dispatchEvent(new MouseEvent('mouseenter'));
  expect(menuItem('4 hours')).toBeDefined();
  menuItem('Snooze · stop agents')?.dispatchEvent(new MouseEvent('mouseenter'));
  expect(document.querySelector('[role="menu"][aria-label="Snooze · keep running"]')).toBeNull();
  expect(document.querySelector('[role="menu"][aria-label="Snooze · stop agents"]')).not.toBeNull();
  menuItem('Minimize (stop agents)')?.dispatchEvent(new MouseEvent('mouseenter'));
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
});

it('navigates the submenu with arrow keys and returns focus with Escape', async () => {
  const trigger = button('Later');
  trigger?.focus();
  trigger?.click();
  const mode = menuItem('Snooze · keep running');
  mode?.focus();
  const key = (value: string) =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    );
  key('ArrowRight');
  await Promise.resolve();
  expect(document.activeElement).toBe(menuItem('15 minutes'));
  key('ArrowDown');
  expect(document.activeElement).toBe(menuItem('30 minutes'));
  key('ArrowLeft');
  expect(document.activeElement).toBe(mode);
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
  key('ArrowRight');
  await Promise.resolve();
  key('Escape');
  expect(document.activeElement).toBe(mode);
  key('Escape');
  expect(document.activeElement).toBe(trigger);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('opens the submenu to the left and keeps it above the bottom edge when space is tight', () => {
  button('Later')?.click();
  const mode = menuItem('Snooze · keep running');
  if (!mode) throw new Error('Missing snooze mode');
  const anchor = new DOMRect(window.innerWidth - 230, window.innerHeight - 90, 210, 30);
  const rect = vi.spyOn(mode, 'getBoundingClientRect').mockReturnValue(anchor);
  try {
    mode.click();
    const submenu = document.querySelector<HTMLElement>(
      '[role="menu"][aria-label="Snooze · keep running"]',
    );
    expect(submenu).not.toBeNull();
    expect(parseFloat(submenu?.style.left ?? '')).toBeLessThan(anchor.left);
    expect(parseFloat(submenu?.style.top ?? '')).toBeLessThan(anchor.top);
    expect(
      parseFloat(submenu?.style.top ?? '') + parseFloat(submenu?.style.maxHeight ?? ''),
    ).toBeLessThanOrEqual(window.innerHeight - 12);
  } finally {
    rect.mockRestore();
  }
});

it.each([
  ['Snooze · keep running', '8 hours', 8],
  ['Snooze · stop agents', '1 week', 168],
] as const)('offers the longest preset for %s', async (mode, label, hours) => {
  button('Later')?.click();
  menuItem(mode)?.click();
  const now = Date.now();
  menuItem(label)?.click();
  await vi.waitFor(() =>
    expect(store.tasks.one.snoozedUntil).toBeGreaterThanOrEqual(now + hours * 3_600_000),
  );
  expect(store.tasks.one.collapsed === true).toBe(mode === 'Snooze · stop agents');
});
