import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../store/types';
import { TaskShellSection } from './TaskShellSection';

vi.mock('../store/store', () => ({
  store: { focusMode: false, taskSplitMode: {} },
  getProject: () => ({
    terminalBookmarks: [
      { id: 'test', command: 'npm test' },
      { id: 'typecheck', command: 'npm run typecheck' },
    ],
  }),
  spawnShellForTask: vi.fn(),
  runBookmarkInTask: vi.fn(),
  closeShell: vi.fn(),
  markAgentOutput: vi.fn(),
  clearAgentActivity: vi.fn(),
  refreshTaskStatus: vi.fn(),
  registerFocusFn: vi.fn(),
  unregisterFocusFn: vi.fn(),
  setActiveTask: vi.fn(),
  setTaskFocusedPanel: vi.fn(),
  shellPanelId: (index: number) => `shell:${index}`,
  isPanelFocused: () => false,
  isPanelFocusedPrefix: () => false,
}));

vi.mock('./TerminalView', () => ({
  TerminalView: () => null,
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

describe('TaskShellSection', () => {
  it('keeps terminal bookmark buttons at their natural width in a horizontally scrollable toolbar', () => {
    const task: Task = {
      id: 'task-1',
      name: 'Task',
      projectId: 'project-1',
      branchName: 'task/bookmarks',
      worktreePath: '/tmp/task',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
    };
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(render(() => <TaskShellSection task={task} isActive />, container));

    const toolbar = container.querySelector<HTMLElement>('.shell-toolbar-panel');
    const buttons = container.querySelectorAll<HTMLElement>('.shell-toolbar-panel > button');

    expect(toolbar?.style.overflowX).toBe('auto');
    expect(toolbar?.style.overflowY).toBe('hidden');
    expect(Array.from(buttons, (button) => button.style.flexShrink)).toEqual(['0', '0', '0']);
  });
});
