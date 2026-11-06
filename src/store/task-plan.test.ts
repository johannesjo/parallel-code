import { beforeEach, describe, expect, it } from 'vitest';
import { store, setStore } from './core';
import type { Task } from './types';
import { applyTaskPlanEvent, taskPlanView } from './task-plan';

const STEPS = [
  { step: 'Read the scripts', status: 'completed' as const },
  { step: 'Check the dev command', status: 'in_progress' as const },
  { step: 'Commit', status: 'pending' as const },
];

beforeEach(() => {
  setStore('tasks', { t1: { id: 't1', agentIds: ['a1'] } as unknown as Task });
});

describe('applyTaskPlanEvent', () => {
  it("replaces the task's plan with each to-do list", () => {
    applyTaskPlanEvent({ taskId: 't1', at: 1, todos: STEPS });
    applyTaskPlanEvent({ taskId: 't1', at: 2, todos: [{ step: 'Only', status: 'pending' }] });
    expect(store.tasks.t1.agentPlan).toEqual({
      steps: [{ step: 'Only', status: 'pending' }],
      updatedAt: 2,
    });
  });

  it('attaches a failed command to the step in progress until the next list', () => {
    applyTaskPlanEvent({ taskId: 't1', at: 1, todos: STEPS });
    applyTaskPlanEvent({ taskId: 't1', at: 2, failedCommand: 'npm run dev' });
    expect(store.tasks.t1.agentPlan?.failedCommand).toBe('npm run dev');
    applyTaskPlanEvent({ taskId: 't1', at: 3, todos: STEPS });
    expect(store.tasks.t1.agentPlan?.failedCommand).toBeUndefined();
  });

  it('drops a failure when no step is in progress', () => {
    applyTaskPlanEvent({ taskId: 't1', at: 2, failedCommand: 'npm test' });
    expect(store.tasks.t1.agentPlan).toBeUndefined();
    applyTaskPlanEvent({ taskId: 't1', at: 3, todos: [{ step: 'Done', status: 'completed' }] });
    applyTaskPlanEvent({ taskId: 't1', at: 4, failedCommand: 'npm test' });
    expect(store.tasks.t1.agentPlan?.failedCommand).toBeUndefined();
  });

  it('ignores events for unknown tasks and events without plan data', () => {
    applyTaskPlanEvent({ taskId: 'gone', at: 1, todos: STEPS });
    applyTaskPlanEvent({ taskId: 't1', at: 1 });
    expect(store.tasks.gone).toBeUndefined();
    expect(store.tasks.t1.agentPlan).toBeUndefined();
  });
});

describe('taskPlanView', () => {
  it("prefers a chat agent's own plan, without the hook plan's failure", () => {
    setStore('tasks', 't1', {
      mainAgentView: 'chat',
      agentPlan: { steps: STEPS, failedCommand: 'npm test', updatedAt: 1 },
    } as Partial<Task>);
    setStore('agents', {
      a1: { chatState: { plan: [{ step: 'Chat step', status: 'pending' }] } } as never,
    });
    expect(taskPlanView('t1')).toEqual({ steps: [{ step: 'Chat step', status: 'pending' }] });
  });

  it('falls back to the hook plan, and to nothing', () => {
    setStore({ agents: {} });
    expect(taskPlanView('t1')).toEqual({ steps: [] });
    const plan = { steps: STEPS, failedCommand: 'npm test', updatedAt: 1 };
    setStore('tasks', 't1', { agentPlan: plan } as Partial<Task>);
    expect(taskPlanView('t1')).toMatchObject({ steps: STEPS, failedCommand: 'npm test' });
  });
});
