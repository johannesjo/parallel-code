import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreateTask, mockToggleNewTaskPanel } = vi.hoisted(() => ({
  mockCreateTask: vi.fn(),
  mockToggleNewTaskPanel: vi.fn(),
}));
vi.mock('./tasks', () => ({ createTask: mockCreateTask }));
vi.mock('./navigation', () => ({ toggleNewTaskPanel: mockToggleNewTaskPanel }));
vi.mock('./task-git-defaults', () => ({
  newTaskGitDefaults: vi.fn(async () => ({
    gitIsolation: 'worktree',
    baseBranch: 'main',
    symlinkDirs: [],
  })),
}));
vi.mock('./github-issue-link', () => ({ linkTaskToIssueReference: vi.fn() }));

import { store, setStore } from './core';
import type { Agent, Project, Task } from './types';
import {
  changeTaskSuggestions,
  dismissTaskSuggestion,
  editTaskSuggestion,
  holdTaskSuggestion,
  markTaskSuggestionStarted,
  pendingTaskSuggestions,
  startTaskSuggestion,
} from './task-suggestions';
import { TASK_SUGGESTION_LIMITS } from '../../electron/shared/task-suggestion';

const input = {
  title: 'Fix stale README badge',
  tldr: 'The badge points at a removed workflow.',
  prompt: 'Update README.md to use the ci.yml badge.',
};

function suggest(extra: Partial<typeof input> = {}): string {
  const result = changeTaskSuggestions('t1', { action: 'suggest', ...input, ...extra });
  if (result.action !== 'suggest') throw new Error('expected a suggest result');
  return result.suggestionId;
}

function task(): Task {
  return store.tasks.t1;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateTask.mockResolvedValue('t2');
  setStore('showNewTaskPanel', false);
  setStore('defaultSkipPermissions', false);
  setStore('newTaskPrefillPrompt', null);
  setStore('projects', [{ id: 'p1', path: '/repo' } as Project]);
  setStore('agents', { 'agent-1': { def: { id: 'claude', name: 'Claude Code' } } as Agent });
  setStore('tasks', {
    t1: {
      id: 't1',
      projectId: 'p1',
      agentIds: ['agent-1'],
      propagateSkipPermissions: true,
      dockerMode: false,
    } as unknown as Task,
  });
});

describe('changeTaskSuggestions', () => {
  it('queues a pending card and returns its id', () => {
    const id = suggest();
    expect(id).toMatch(/^suggestion_[a-z0-9]{8}$/);
    expect(pendingTaskSuggestions(task())).toMatchObject([{ id, ...input, status: 'pending' }]);
  });

  it('returns the card already shown for a repeated suggestion', () => {
    expect(suggest()).toBe(suggest());
    expect(pendingTaskSuggestions(task())).toHaveLength(1);
  });

  it('caps unanswered suggestions per task, but still answers a repeat', () => {
    for (let i = 0; i < TASK_SUGGESTION_LIMITS.pending; i++) suggest({ title: `Task ${i}` });
    expect(() => suggest({ title: 'One more' })).toThrow('has not answered');
    expect(suggest({ title: 'Task 0' })).toBe(pendingTaskSuggestions(task())[0].id);
  });

  it('refuses to suggest again what the user dismissed', () => {
    dismissTaskSuggestion('t1', suggest());
    expect(() => suggest({ prompt: 'Reworded.' })).toThrow('already dismissed');
    // Answered entries keep only what a late withdraw or repeat check needs.
    expect(task().taskSuggestions?.[0]).toMatchObject({
      status: 'dismissed',
      prompt: '',
      tldr: '',
    });
  });

  it('rejects hidden agents that have no task panel', () => {
    setStore('tasks', 'doc-agent-p1', { id: 'doc-agent-p1' } as unknown as Task);
    expect(() => changeTaskSuggestions('doc-agent-p1', { action: 'suggest', ...input })).toThrow(
      'Task not available',
    );
  });

  it('rejects unknown and closing tasks', () => {
    expect(() => changeTaskSuggestions('toString', { action: 'suggest', ...input })).toThrow(
      'Task not available',
    );
    setStore('tasks', 't1', 'closingStatus', 'closing');
    expect(() => suggest()).toThrow('Task not available');
  });

  it('withdraws a pending card, but never overrides the user’s answer', () => {
    const id = suggest();
    expect(changeTaskSuggestions('t1', { action: 'withdraw', suggestionId: id })).toMatchObject({
      withdrawn: true,
      status: 'withdrawn',
    });
    expect(pendingTaskSuggestions(task())).toEqual([]);

    const dismissed = suggest({ title: 'Other' });
    dismissTaskSuggestion('t1', dismissed);
    expect(
      changeTaskSuggestions('t1', { action: 'withdraw', suggestionId: dismissed }),
    ).toMatchObject({
      withdrawn: false,
      status: 'dismissed',
      message: expect.stringContaining('final'),
    });

    const started = suggest({ title: 'Third' });
    markTaskSuggestionStarted('t1', started, 't9');
    expect(
      changeTaskSuggestions('t1', { action: 'withdraw', suggestionId: started }),
    ).toMatchObject({ withdrawn: false, status: 'started' });
    expect(() =>
      changeTaskSuggestions('t1', { action: 'withdraw', suggestionId: 'suggestion_00000000' }),
    ).toThrow('No suggestion');
  });
});

describe('startTaskSuggestion', () => {
  it('creates a background task with the suggesting task’s agent and marks it started', async () => {
    const id = suggest();
    await expect(startTaskSuggestion('t1', id)).resolves.toBe('t2');
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        name: input.title,
        initialPrompt: input.prompt,
        projectId: 'p1',
        agentDef: { id: 'claude', name: 'Claude Code' },
        gitIsolation: 'worktree',
        // The suggesting task propagates bypass, but a user's Start follows their own default.
        skipPermissions: false,
        activate: false,
      }),
    );
    expect(task().taskSuggestions?.[0]).toMatchObject({ status: 'started', startedTaskId: 't2' });
    await expect(startTaskSuggestion('t1', id)).rejects.toThrow('no longer available');
  });

  it('keeps the card when creation fails', async () => {
    mockCreateTask.mockRejectedValue(new Error('worktree failed'));
    const id = suggest();
    await expect(startTaskSuggestion('t1', id)).rejects.toThrow('worktree failed');
    expect(pendingTaskSuggestions(task())).toHaveLength(1);
  });
});

describe('a suggestion in the user’s hands', () => {
  function deferredCreate() {
    let resolve: (id: string) => void = () => {};
    mockCreateTask.mockReturnValue(new Promise<string>((r) => (resolve = r)));
    return (id: string) => resolve(id);
  }

  it('cannot be withdrawn, dismissed or started again while its task is built', async () => {
    const finish = deferredCreate();
    const id = suggest();
    const started = startTaskSuggestion('t1', id);
    expect(changeTaskSuggestions('t1', { action: 'withdraw', suggestionId: id })).toMatchObject({
      withdrawn: false,
      message: expect.stringContaining('starting or editing'),
    });
    dismissTaskSuggestion('t1', id);
    await expect(startTaskSuggestion('t1', id)).rejects.toThrow('already being started');
    finish('t2');
    await started;
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    expect(task().taskSuggestions?.[0]).toMatchObject({ status: 'started', startedTaskId: 't2' });
  });

  it('is held by an Edit-first form, then by the creation it submits', async () => {
    const id = suggest();
    editTaskSuggestion('t1', id);
    setStore('showNewTaskPanel', true);
    expect(changeTaskSuggestions('t1', { action: 'withdraw', suggestionId: id })).toMatchObject({
      withdrawn: false,
    });
    await expect(startTaskSuggestion('t1', id)).rejects.toThrow('already being started or edited');
    // The form closes on submit; the hold keeps the agent out until the task exists.
    setStore('showNewTaskPanel', false);
    const release = holdTaskSuggestion(id);
    expect(changeTaskSuggestions('t1', { action: 'withdraw', suggestionId: id })).toMatchObject({
      withdrawn: false,
    });
    markTaskSuggestionStarted('t1', id, 't3');
    release();
    expect(task().taskSuggestions?.[0]).toMatchObject({ status: 'started', startedTaskId: 't3' });
  });

  it('refuses to start from a closing task or one without an agent', async () => {
    const id = suggest();
    setStore('tasks', 't1', 'agentIds', []);
    await expect(startTaskSuggestion('t1', id)).rejects.toThrow('no agent');
    setStore('tasks', 't1', 'closingStatus', 'closing');
    await expect(startTaskSuggestion('t1', id)).rejects.toThrow('no longer available');
    expect(mockCreateTask).not.toHaveBeenCalled();
  });
});

describe('editTaskSuggestion', () => {
  it('prefills the New Task form, but never over an open one', () => {
    const id = suggest();
    expect(editTaskSuggestion('t1', id)).toBe(true);
    expect(store.newTaskPrefillPrompt).toMatchObject({
      prompt: input.prompt,
      name: input.title,
      projectId: 'p1',
      taskSuggestion: { taskId: 't1', suggestionId: id },
    });
    expect(mockToggleNewTaskPanel).toHaveBeenCalledWith(true);
    // Still pending until the task exists.
    expect(pendingTaskSuggestions(task())).toHaveLength(1);
    setStore('showNewTaskPanel', true);
    expect(editTaskSuggestion('t1', id)).toBe(false);
  });
});
