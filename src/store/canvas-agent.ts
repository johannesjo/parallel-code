import { parseCanvasRequest, type CanvasView } from '../../electron/shared/canvas-view';
import { store, setStore } from './core';
import { openCanvasMindMap, openCanvasReasoning } from './canvas';
import { getTaskReasoning } from './reasoning';

let focusSeq = 0;

async function canvasNodeIds(taskId: string, view: CanvasView): Promise<string[]> {
  if (view === 'mindmap') return store.tasks[taskId].mindMap?.records.map((node) => node.id) ?? [];
  const { graph } = await getTaskReasoning(taskId);
  return graph?.records.map((record) => record.id) ?? [];
}

/** Agents open a view on request ("show me the reasoning graph"); content stays untouched. */
export async function openCanvasViewFromAgent(taskId: string, input: unknown): Promise<void> {
  const { view, focusId } = parseCanvasRequest(input);
  if (!Object.hasOwn(store.tasks, taskId) || store.tasks[taskId].closingStatus)
    throw new Error('Task not available.');
  // Checked before opening so a wrong id leaves the user's view alone.
  if (focusId !== undefined && !(await canvasNodeIds(taskId, view)).includes(focusId))
    throw new Error(`No node "${focusId}" in the ${view} canvas; read it first for valid ids.`);
  if (focusId !== undefined)
    setStore('tasks', taskId, 'canvasFocusRequest', { view, nodeId: focusId, seq: ++focusSeq });
  if (view === 'mindmap') openCanvasMindMap(taskId);
  else {
    const agentId = store.tasks[taskId].agentIds[0];
    const agent = store.agents[agentId];
    if (agent)
      setStore('tasks', taskId, 'reasoningCanvasRequest', {
        agentId,
        generation: agent.generation,
      });
    openCanvasReasoning(taskId);
  }
}
