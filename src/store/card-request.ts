import { store } from './core';
import { sendPrompt } from './tasks';

/**
 * Asks the task's agent to fill one of its agent cards; the answer arrives
 * through `card_publish`. Agents skip the standing instruction often enough
 * that Finish needs a way to ask on the spot.
 */
export async function requestAgentCard(taskId: string, cardId: string): Promise<void> {
  const agentId = store.tasks[taskId]?.agentIds[0];
  if (!agentId) throw new Error('The task has no agent.');
  const name = store.cardDefinitions.find((card) => card.id === cardId)?.name ?? cardId;
  await sendPrompt(
    taskId,
    agentId,
    `Fill the "${name}" card for this task: call card_list, then card_publish with card "${cardId}" and a value for each slot that applies, following the slot hints. ` +
      'Base it on what you know about this work so far. Do not change files, commit or push.',
    { appPrompt: true },
  );
}
