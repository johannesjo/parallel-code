import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { TerminalPanel } from './TerminalPanel';

vi.mock('./TerminalView', () => ({ TerminalView: () => <div /> }));

let dispose: (() => void) | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  setStore({
    terminals: { term: { id: 'term', name: 'Terminal', agentId: 'shell' } },
    taskOrder: ['term'],
    activeTaskId: 'term',
    newTaskPanelFocused: false,
  });
  container = document.createElement('div');
  document.body.append(container);
  dispose = render(
    () => <TerminalPanel terminal={{ id: 'term', name: 'Terminal', agentId: 'shell' }} isActive />,
    container,
  );
});

afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

it('drops the active column and header highlight while the new-task draft holds focus', () => {
  const column = container.querySelector('.task-column');
  expect(column?.classList.contains('active')).toBe(true);
  expect(container.querySelector('.island-header-active')).not.toBeNull();

  setStore('newTaskPanelFocused', true);
  expect(column?.classList.contains('active')).toBe(false);
  expect(container.querySelector('.island-header-active')).toBeNull();
});
