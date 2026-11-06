import type { AgentHookEventPayload } from '../../electron/agent-hooks/status';
import { store, setStore } from './core';
import type { TaskAgentPlan } from './types';

type PlanEvent = Pick<AgentHookEventPayload, 'taskId' | 'at' | 'todos' | 'failedCommand'>;

/**
 * Keeps the task's plan in step with its lead agent. A to-do list replaces
 * the plan outright (TodoWrite always sends the whole list); a failed command
 * is shown under the step in progress until the agent writes its next list.
 */
export function applyTaskPlanEvent(event: PlanEvent): void {
  const task = store.tasks[event.taskId];
  if (!task) return;
  if (event.todos) {
    // Set on the task, not at the plan's path: Solid merges objects written to
    // a path, which would keep the previous list's failed command.
    setStore('tasks', event.taskId, { agentPlan: { steps: event.todos, updatedAt: event.at } });
    return;
  }
  const plan = task.agentPlan;
  if (!event.failedCommand || !plan?.steps.some((step) => step.status === 'in_progress')) return;
  setStore('tasks', event.taskId, 'agentPlan', 'failedCommand', event.failedCommand);
}

/** The plan task context shows: a chat agent states its own (Claude's
 *  TodoWrite or Codex's plan); a terminal agent's arrives through hooks. */
export function taskPlanView(taskId: string): Pick<TaskAgentPlan, 'steps' | 'failedCommand'> {
  const task = store.tasks[taskId];
  if (!task) return { steps: [] };
  const chatPlan = store.agents[task.agentIds[0]]?.chatState?.plan;
  if (chatPlan?.length) return { steps: chatPlan };
  return task.agentPlan ?? { steps: [] };
}
