import { createSignal } from 'solid-js';
import { sameCanvasNode, type CanvasTaskSource } from '../lib/canvas-task-links';
import { store, setStore } from './core';
import { saveState } from './persistence';
import { createTask, type CreateTaskOptions } from './tasks';
import { showNotification } from './notification';

// Reserve nodes across asynchronous worktree creation, including two panes of the same map.
const [pending, setPending] = createSignal<CanvasTaskSource[]>([]);
export const canvasTaskPending = (source: CanvasTaskSource): boolean =>
  pending().some((item) => item.taskId === source.taskId && sameCanvasNode(item, source));

export function canvasTaskLink(source: CanvasTaskSource) {
  return store.tasks[source.taskId]?.canvasTaskLinks?.find((link) => sameCanvasNode(link, source));
}

export function validateCanvasTaskSource(source: CanvasTaskSource, projectId?: string): void {
  if (source.canvas === 'reasoning' && (!source.runId || !source.agentId))
    throw new Error('Wait for the reasoning graph to load before creating a task.');
  const task = store.tasks[source.taskId];
  if (!task || task.closingStatus) throw new Error('The source task is no longer available.');
  if (projectId !== undefined && projectId !== task.projectId)
    throw new Error('Create the linked task in the source project.');
  if (canvasTaskPending(source)) throw new Error('A task is already being created for this node.');
  if (canvasTaskLink(source)) throw new Error('This node already has a task. Unlink it first.');
}

function saveLink(source: CanvasTaskSource, taskId: string): void {
  const owner = store.tasks[source.taskId];
  const task = store.tasks[taskId];
  if (!owner || !task) return;
  setStore('tasks', owner.id, 'canvasTaskLinks', [
    ...(owner.canvasTaskLinks ?? []),
    {
      canvas: source.canvas,
      runId: source.runId,
      agentId: source.agentId,
      nodeId: source.nodeId,
      taskId,
      taskName: task.name,
    },
  ]);
  saveState();
}

export function linkCanvasTask(source: CanvasTaskSource, taskId: string): void {
  validateCanvasTaskSource(source);
  const task = store.tasks[taskId];
  if (
    !task ||
    task.closingStatus ||
    taskId === source.taskId ||
    task.projectId !== store.tasks[source.taskId].projectId
  )
    throw new Error('Choose another available task in this project.');
  saveLink(source, taskId);
}

export function unlinkCanvasTask(source: CanvasTaskSource): void {
  if (!store.tasks[source.taskId] || canvasTaskPending(source)) return;
  setStore('tasks', source.taskId, 'canvasTaskLinks', (links) =>
    links?.filter((link) => !sameCanvasNode(link, source)),
  );
  saveState();
}

export async function createCanvasTask(
  source: CanvasTaskSource,
  options: CreateTaskOptions,
): Promise<string> {
  validateCanvasTaskSource(source, options.projectId);
  setPending((items) => [...items, source]);
  try {
    const taskId = await createTask(options);
    if (store.tasks[source.taskId]) saveLink(source, taskId);
    else
      showNotification(
        'Task created. Its source task was closed, so the canvas link could not be saved.',
      );
    return taskId;
  } finally {
    setPending((items) => items.filter((item) => item !== source));
  }
}
