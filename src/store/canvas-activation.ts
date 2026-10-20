import { store } from './core';
import { isAgentAskingQuestion, isAgentIdle } from './taskStatus';
import { getAgentHookStatus } from './agentHookStatus';
import type { ActivationInput } from '../investigation/live-activation';
import type { Task } from './types';

/** What the canvases read from the store to decide whether the agent can take a chat request. */
export function canvasActivationInput(
  task: Pick<Task, 'closingStatus' | 'initialPrompt' | 'terminalInputPending'> | undefined,
  agentId: string | undefined,
): ActivationInput {
  const agent = agentId ? store.agents[agentId] : undefined;
  const hook = agentId ? getAgentHookStatus(agentId) : null;
  return {
    hasSource: !!task && !!agentId,
    agentStatus: agent?.status,
    canvasTools: agent?.canvasTools,
    closing: !!task?.closingStatus,
    awaitingInitialPrompt: !!task?.initialPrompt,
    hookState: hook?.state,
    askingQuestion: !!agentId && isAgentAskingQuestion(agentId),
    terminalInputPending: !!task?.terminalInputPending,
    idle: !!agentId && isAgentIdle(agentId),
  };
}
