import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '../lib/ipc';
import { store, setStore } from '../store/core';
import { applyAgentHookEvent } from '../store/agentHookStatus';
import { clearAgentActivity } from '../store/taskStatus';
import { clearTaskLandingReview, uncollapseTask } from '../store/tasks';
import { setDelegationStates } from '../store/delegation';
import type { Task } from '../store/types';
import { AttentionTray } from './AttentionTray';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock('../store/tasks', () => ({
  uncollapseTask: vi.fn(),
  clearTaskLandingReview: vi.fn(),
}));

const task: Task = {
  id: 'child',
  name: 'Child result',
  projectId: 'project',
  branchName: 'child',
  worktreePath: '/repo/child',
  agentIds: ['one', 'two'],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
  coordinatedBy: 'parent',
  integrationPolicy: 'review',
};
let host: HTMLDivElement;
let dispose: () => void;
const rows = () => [...host.querySelectorAll<HTMLButtonElement>('.sidebar-attention-row')];
beforeEach(() => {
  vi.clearAllMocks();
  setStore('tasks', reconcile({ child: { ...task } }));
  setStore('agents', reconcile({}));
  for (const id of task.agentIds) {
    setStore('agents', id, {
      id,
      taskId: 'child',
      def: {
        id,
        name: 'Claude',
        command: 'claude',
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: '',
      },
      resumed: false,
      status: 'running',
      exitCode: null,
      signal: null,
      lastOutput: [],
      generation: 0,
    });
  }
  setStore('projects', [
    { id: 'project', name: 'Hidden project', path: '/repo', color: '#fff', tasksCollapsed: true },
  ]);
  setStore('taskOrder', ['child']);
  setStore('collapsedTaskOrder', []);
  setStore('activeTaskId', null);
  setStore('sidebarNeedsInputFirst', true);
  setDelegationStates('child', reconcile({ attempts: [], messages: [], paused: false }));
  host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <AttentionTray nowMs={Date.now()} />, host);
});
afterEach(() => {
  dispose();
  for (const id of task.agentIds) clearAgentActivity(id);
  document.body.replaceChildren();
});

it('routes every asker in hidden projects and preserves row focus when another action arrives', () => {
  applyAgentHookEvent({
    agentId: 'two',
    taskId: 'child',
    state: 'waiting',
    event: 'PermissionRequest',
    at: Date.now(),
  });
  const question = rows()[0];
  question.focus();
  setStore('tasks', 'child', 'needsReview', true);
  expect(rows()).toHaveLength(2);
  expect(rows()[0]).toBe(question);
  expect(document.activeElement).toBe(question);
  question.click();
  expect(store.activeAgentId).toBe('two');
  expect(store.focusedPanel.child).toBe('ai-terminal:two');
  expect(store.tasks.child.needsReview).toBe(true);
  expect(clearTaskLandingReview).not.toHaveBeenCalled();
  expect(uncollapseTask).not.toHaveBeenCalled();
});

it('opens an unmerged child review in its task, where Finish merges it', () => {
  setStore('tasks', 'child', { collapsed: true, needsReview: true });
  setStore('taskOrder', []);
  setStore('collapsedTaskOrder', ['child']);
  expect(rows()[0].textContent).toContain('Resume and open');
  rows()[0].click();
  expect(uncollapseTask).toHaveBeenCalledWith('child');
  expect(invoke).not.toHaveBeenCalled();
  expect(clearTaskLandingReview).not.toHaveBeenCalled();
});

it('keeps an already merged result until explicit acknowledgment without requesting a merge', () => {
  setStore('tasks', 'child', {
    collapsed: true,
    landingState: 'landed_pending_review',
    landingSummary: 'Added search',
  });
  rows()[0].click();
  expect(document.body.textContent).toContain('Added search');
  expect(document.body.textContent).not.toContain('Approve and merge');
  expect(rows()).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalled();
  expect(uncollapseTask).not.toHaveBeenCalled();
  const acknowledge = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Mark reviewed',
  );
  expect(acknowledge).toBeDefined();
  acknowledge?.click();
  expect(clearTaskLandingReview).toHaveBeenCalledWith('child');
});

it('labels a collapsed ordinary task action as a resume and leaves its reason unresolved', () => {
  setStore('tasks', 'child', {
    collapsed: true,
    coordinatedBy: undefined,
    integrationPolicy: undefined,
    needsReview: true,
  });
  expect(rows()[0].textContent).toContain('Resume and open');
  rows()[0].click();
  expect(uncollapseTask).toHaveBeenCalledWith('child');
  expect(store.tasks.child.needsReview).toBe(true);
  expect(clearTaskLandingReview).not.toHaveBeenCalled();
});

it('opens failure context without dismissing it or submitting terminal input', () => {
  setDelegationStates('child', {
    attempts: [
      {
        parentTaskId: 'child',
        requestId: 'failed',
        name: 'Worker',
        status: 'failed',
        error: 'Launch refused',
      },
    ],
    messages: [],
    paused: false,
  });
  expect(rows()[0].title).toContain('Launch refused');
  rows()[0].click();
  expect(store.activeTaskId).toBe('child');
  expect(rows()).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalled();
});
