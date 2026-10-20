import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { TaskProjectFilter } from './TaskProjectFilter';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  setStore('taskProjectFilter', null);
});

it('offers project colors, selection, keyboard dismissal and a one-click reset', async () => {
  setStore({
    projects: [
      { id: 'one', name: 'One', color: '#abc', path: '/one' },
      { id: 'two', name: 'Two', color: '#def', path: '/two' },
    ],
    taskProjectFilter: 'one',
    taskOrder: [],
    activeTaskId: null,
  });
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <TaskProjectFilter />, host);
  const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
  trigger?.click();
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute('role')).toBe('menuitemradio'),
  );
  expect(document.activeElement?.textContent).toContain('One');
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
  );
  expect(document.activeElement?.textContent).toContain('Two');
  (document.activeElement as HTMLButtonElement).click();
  expect(store.taskProjectFilter).toBe('two');
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  trigger?.click();
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute('role')).toBe('menuitemradio'),
  );
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  const clear = host.querySelector<HTMLButtonElement>('[aria-label="Show all projects"]');
  clear?.focus();
  clear?.click();
  expect(document.activeElement).toBe(trigger);
  expect(store.taskProjectFilter).toBeNull();
  expect(trigger?.textContent).toContain('All projects');
});
