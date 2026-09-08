import { describe, it, expect } from 'vitest';
import { store, setStore } from './core';
import { persistedSnapshot } from './autosave';
import type { Task } from './types';

describe('autosave snapshot includes new-task-default fields', () => {
  it('defaultStepsEnabled changes the snapshot', () => {
    setStore('defaultStepsEnabled', false);
    const before = persistedSnapshot();
    setStore('defaultStepsEnabled', true);
    const after = persistedSnapshot();
    expect(before).not.toBe(after);
    setStore('defaultStepsEnabled', false);
  });

  it('defaultSkipPermissions changes the snapshot', () => {
    setStore('defaultSkipPermissions', false);
    const before = persistedSnapshot();
    setStore('defaultSkipPermissions', true);
    const after = persistedSnapshot();
    expect(before).not.toBe(after);
    setStore('defaultSkipPermissions', false);
  });

  it('defaultPropagateSkipPermissions changes the snapshot', () => {
    setStore('defaultPropagateSkipPermissions', false);
    const before = persistedSnapshot();
    setStore('defaultPropagateSkipPermissions', true);
    const after = persistedSnapshot();
    expect(before).not.toBe(after);
    setStore('defaultPropagateSkipPermissions', false);
  });

  it('terminalScreenReaderMode changes the snapshot', () => {
    setStore('terminalScreenReaderMode', false);
    const before = persistedSnapshot();
    setStore('terminalScreenReaderMode', true);
    const after = persistedSnapshot();
    expect(before).not.toBe(after);
    setStore('terminalScreenReaderMode', false);
  });

  it('showSteps is not tracked separately (migrated to defaultStepsEnabled)', () => {
    expect('showSteps' in store).toBe(false);
  });

  it('branch adoption banner fields change the snapshot', () => {
    // Dismissing the adoption banner touches only these fields — if they ever
    // drop out of the snapshot, the dismissal survives until the next unrelated
    // change and then silently never persists on its own.
    const taskId = 'autosave-banner-task';
    const task: Task = {
      id: taskId,
      name: taskId,
      projectId: 'p1',
      branchName: 'feature/adopted',
      worktreePath: '/tmp/autosave-banner-task',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
    };
    setStore('tasks', taskId, task);
    setStore('taskOrder', (order) => [...order, taskId]);
    try {
      const before = persistedSnapshot();
      setStore('tasks', taskId, 'branchAdoptedFrom', 'task/original');
      const afterAdopt = persistedSnapshot();
      expect(afterAdopt).not.toBe(before);

      setStore('tasks', taskId, 'branchAdoptedFrom', undefined);
      setStore('tasks', taskId, 'branchOfferDismissed', 'feature/adopted');
      const afterDismiss = persistedSnapshot();
      expect(afterDismiss).not.toBe(before);
      expect(afterDismiss).not.toBe(afterAdopt);
    } finally {
      setStore('taskOrder', (order) => order.filter((id) => id !== taskId));
      setStore('tasks', taskId, undefined as unknown as Task);
    }
  });
});
