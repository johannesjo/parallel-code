import { parseAgentTourPayload } from '../../electron/shared/agent-tour';
import { store, setStore } from './core';
import { stageCanvasRequest } from './canvas';

/**
 * Accepts a tour the coding agent published through the `tour_publish` MCP tool.
 * Only shape and size are checked here; the cards are validated in the panel,
 * which then opens the viewer. The payload persists with the task.
 */
export function publishAgentTour(taskId: string, input: unknown): void {
  const payload = parseAgentTourPayload(input);
  if (!Object.hasOwn(store.tasks, taskId) || store.tasks[taskId].closingStatus)
    throw new Error('Task not available.');
  const revision = (store.tasks[taskId].agentTour?.revision ?? 0) + 1;
  setStore('tasks', taskId, 'agentTour', { revision, payload });
}

/**
 * Hands one tour card to the task's agent: the reference joins the prompt
 * draft, after anything already typed, and waits there to be sent.
 */
export function referenceTourCard(taskId: string, reference: string): void {
  if (reference.trim()) stageCanvasRequest(taskId, reference);
}
