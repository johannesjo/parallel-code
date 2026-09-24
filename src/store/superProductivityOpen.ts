/**
 * "Start in Parallel Code" from Super Productivity: a `parallelcode://` link
 * parks a Super Productivity task id in the main process; this pulls it,
 * fetches the task and pre-fills the New Task panel. Nothing starts until the
 * user submits the form.
 */
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { warn as logWarn } from '../lib/log';
import { store, setStore } from './core';
import { setActiveTask, toggleNewTaskPanel } from './navigation';
import { showNotification } from './notification';
import {
  buildPromptFromSpTask,
  type SpFailureReason,
  type SpResult,
  type SpTaskDetail,
} from '../../electron/shared/super-productivity';
import { onTaskRenamed, setProjectSpMapping, setSpLink } from './superProductivity';
import type { SpNewTaskSource } from './types';

function failureMessage(reason: SpFailureReason): string {
  switch (reason) {
    case 'not_configured':
      return 'Connect Super Productivity in Settings to open its tasks here';
    case 'disabled':
      return 'Turn on the Local REST API in Super Productivity’s settings';
    case 'unauthorized':
      return 'Super Productivity rejected the access token — update it in Settings';
    case 'not_found':
      return 'That task no longer exists in Super Productivity';
    default:
      return 'Could not reach Super Productivity';
  }
}

async function openNewTaskFromSp(spTaskId: string): Promise<void> {
  const res = await invoke<SpResult<SpTaskDetail>>(IPC.SuperProductivityGetTask, {
    taskId: spTaskId,
    includeIssueUrl: true,
  });
  if (!res.ok) {
    showNotification(failureMessage(res.reason));
    return;
  }
  const spTask = res.value;

  // Already has a task here: go to it rather than creating a second one.
  const existing = Object.values(store.tasks).find(
    (task) => task.superProductivity?.taskId === spTask.id && !task.closingStatus,
  );
  if (existing) {
    // Expanding a collapsed task restarts its agents; leave that to the user.
    if (existing.collapsed) showNotification(`“${existing.name}” is collapsed in Parallel Code`);
    else setActiveTask(existing.id);
    return;
  }

  if (store.showNewTaskPanel) {
    showNotification('Finish or close the open New Task form first');
    return;
  }
  const projectId =
    store.projects.find(
      (p) =>
        spTask.projectId !== null &&
        p.superProductivityProjectId === spTask.projectId &&
        (p.kind ?? 'code') === 'code',
    )?.id ?? null;
  const source: SpNewTaskSource = {
    taskId: spTask.id,
    title: spTask.title.trim(),
    projectId: spTask.projectId,
  };
  setStore('newTaskDropUrl', null);
  setStore('newTaskPrefillPrompt', {
    prompt: buildPromptFromSpTask(spTask),
    name: source.title,
    projectId,
    superProductivity: source,
  });
  toggleNewTaskPanel(true);
}

/**
 * Link a task created from a Super Productivity task, and remember the
 * project pairing the user just made if the project had none.
 */
export function linkNewTaskToSp(taskId: string, source: SpNewTaskSource, projectId: string): void {
  setSpLink(taskId, source.taskId, source.title);
  const project = store.projects.find((p) => p.id === projectId);
  if (project && !project.superProductivityProjectId && source.projectId) {
    setProjectSpMapping(project.id, source.projectId);
  }
  // A name edited in the form wins, like any other rename.
  if (store.tasks[taskId]?.name.trim() !== source.title) onTaskRenamed(taskId);
}

export function startSpOpenListener(): () => void {
  const consume = async (): Promise<void> => {
    const spTaskId = await invoke<string | null>(IPC.SuperProductivityConsumePendingOpen);
    if (spTaskId) await openNewTaskFromSp(spTaskId);
  };
  const run = () =>
    void consume().catch((err: unknown) =>
      logWarn('super-productivity', 'Could not open task from Super Productivity', {
        err: String(err),
      }),
    );
  const off = window.electron.ipcRenderer.on(IPC.SuperProductivityOpenTaskRequested, run);
  run();
  return off;
}
