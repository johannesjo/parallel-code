// Title-bar tabs: each open item's pill must carry its project's colour so tabs
// from the same project read as a group. See FocusModeTaskIndicators.tsx.
import { afterEach, expect, it, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { FocusModeTaskIndicators } from './FocusModeTaskIndicators';
import { setStore } from '../store/core';
import type { Project, Task } from '../store/types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));

function task(id: string, projectId: string): Task {
  return {
    id,
    name: id,
    projectId,
    branchName: id,
    worktreePath: `/tmp/${id}`,
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
  };
}

function project(id: string, color: string): Project {
  return { id, name: id, path: `/tmp/${id}`, color };
}

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  setStore('tasks', reconcile({}));
  setStore('agents', reconcile({}));
  setStore('projects', reconcile([]));
  setStore('taskOrder', []);
  setStore('taskProjectFilter', null);
  setStore('activeTaskId', null);
});

it('carries each open tab\u2019s project colour', () => {
  setStore('projects', reconcile([project('blue', '#3b82f6'), project('red', '#ef4444')]));
  setStore(
    'tasks',
    reconcile({ blueTask: task('blueTask', 'blue'), redTask: task('redTask', 'red') }),
  );
  setStore('agents', reconcile({}));
  setStore('taskOrder', ['blueTask', 'redTask']);
  setStore('activeTaskId', 'blueTask');

  const host = document.createElement('div');
  document.body.appendChild(host);
  dispose = render(() => <FocusModeTaskIndicators />, host);

  const tabs = host.querySelectorAll<HTMLButtonElement>('.focus-mode-task-indicator');
  expect(tabs).toHaveLength(2);
  expect(tabs[0].style.getPropertyValue('--tab-project-color')).toBe('#3b82f6');
  expect(tabs[1].style.getPropertyValue('--tab-project-color')).toBe('#ef4444');
});
