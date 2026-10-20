import { beforeEach, expect, it } from 'vitest';
import { setStore } from './core';
import { isTaskColumnHighlighted } from './focused-panel';

beforeEach(() => {
  setStore({ activeTaskId: 'task-1', newTaskPanelFocused: false });
});

it('highlights only the active task column', () => {
  expect(isTaskColumnHighlighted('task-1')).toBe(true);
  expect(isTaskColumnHighlighted('task-2')).toBe(false);
});

it('dims the active task column while the new-task draft holds focus', () => {
  setStore('newTaskPanelFocused', true);
  expect(isTaskColumnHighlighted('task-1')).toBe(false);
});

it('highlights nothing for a column without a task id', () => {
  setStore('activeTaskId', null);
  expect(isTaskColumnHighlighted(null)).toBe(false);
});
