import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import type { Task } from '../store/types';
import { TaskBranchInfoBar } from './TaskBranchInfoBar';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));

const task = {
  id: 'task-1',
  name: 'Fix CI',
  projectId: 'project-1',
  branchName: 'task/fix-ci',
  worktreePath: '/repo/.worktrees/fix-ci',
  agentIds: [],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
} as Task;

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent === label,
  );

it('opens the project menu from the header chip and its settings entry', () => {
  setStore('projects', [{ id: 'project-1', name: 'App', path: '/repo', color: '#888' }]);
  const onEditProject = vi.fn();
  dispose = render(
    () => <TaskBranchInfoBar task={task} onEditProject={onEditProject} />,
    document.body,
  );
  document.querySelector<HTMLButtonElement>('.task-branch-project')?.click();

  expect(menuItem('Plan board')).toBeDefined();
  menuItem('Settings…')?.click();
  expect(onEditProject).toHaveBeenCalledWith('project-1');
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
