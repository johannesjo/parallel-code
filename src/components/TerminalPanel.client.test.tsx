import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { clearAgentActivity, isAgentIdle } from '../store/taskStatus';
import { TerminalPanel } from './TerminalPanel';

type ViewProps = {
  onData?: (data: Uint8Array) => void;
  onExit?: (info: {
    exit_code: number | null;
    signal: string | null;
    last_output: string[];
  }) => void;
};
const viewProps = vi.hoisted(() => [] as ViewProps[]);
vi.mock('./TerminalView', () => ({
  TerminalView: (props: ViewProps) => {
    viewProps.push(props);
    return null;
  },
}));

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
  clearAgentActivity('shell');
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

it('counts its output as activity, so the board can show it running', () => {
  expect(isAgentIdle('shell')).toBe(true);
  viewProps.at(-1)?.onData?.(new TextEncoder().encode('Compiling...\r\n'));
  expect(isAgentIdle('shell')).toBe(false);
});

it('stops counting as running once its shell exits', () => {
  viewProps.at(-1)?.onData?.(new TextEncoder().encode('Compiling...\r\n'));
  viewProps.at(-1)?.onExit?.({ exit_code: 0, signal: null, last_output: [] });
  expect(isAgentIdle('shell')).toBe(true);
});
