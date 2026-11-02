import { createEffect, createRoot } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { askCodeEnvFile } from '../../electron/shared/ask-code-models';
import type { ServeCommands, TaskScreensResult } from '../../electron/shared/task-screens';
import { areScreensOutdated } from '../lib/finish-reports';
import { invoke } from '../lib/ipc';
import { diffFingerprint } from '../lib/task-brief';
import { getTaskDiffBaseBranch } from '../lib/load-task-diff';
import { errMessage, warn as logWarn } from '../lib/log';
import { store } from './core';
import { showNotification, NOTIFICATION_ERROR_MS } from './notification';
import { isLiveTask, noteCodeFingerprint, readTaskDiff } from './task-brief';
import { openTaskReview } from './task-review';

/** A finished capture, with when it ran and the diff it saw then. */
type CapturedTaskScreens = TaskScreensResult & { capturedAt: number; fingerprint?: string };

export type TaskScreensStatus =
  | { state: 'running'; startedAt: number; step?: string; commands?: ServeCommands }
  | { state: 'failed'; message: string }
  | ({ state: 'done' } & CapturedTaskScreens);

// Not persisted: the images live in a temporary folder that a restart may clear.
const [screens, setScreens] = createStore<Record<string, TaskScreensStatus | undefined>>({});
const cancelled = new Set<string>();
/** Per task with screens: stops watching for the task closing. */
const watchers = new Map<string, () => void>();
/** Tasks whose latest screens arrived and have not been shown yet. */
const unseen = new Set<string>();

/**
 * Whether screens arrived since the task's screens were last shown; asking
 * counts as showing them. The user asked for them, so they open unfolded.
 */
export function takeUnseenScreens(taskId: string): boolean {
  return unseen.delete(taskId);
}

/** The capture runs Claude Code's CLI, so it is offered only where Claude is installed. */
export function canCaptureScreens(): boolean {
  return store.availableAgents.some(
    (agent) => agent.command === 'claude' && agent.available !== false,
  );
}

/** A task's latest capture: running, failed, or its shots. */
export function taskScreens(taskId: string): TaskScreensStatus | undefined {
  return screens[taskId];
}

/** Whether the task's finished capture shows older code than the task has now. */
export function areTaskScreensOutdated(taskId: string, headSha?: string | null): boolean {
  const status = screens[taskId];
  const task = store.tasks[taskId];
  if (status?.state !== 'done' || !task) return false;
  const code = { codeFingerprint: task.codeFingerprint, brief: task.brief, headSha };
  return areScreensOutdated(status, code);
}

/** Tells the backend to stop the run, if any, and delete the task's screenshots. */
function discardInBackend(taskId: string): void {
  void invoke(IPC.CancelTaskScreens, { taskId }).catch((error: unknown) =>
    logWarn('taskScreens', 'Cancel failed', { error: errMessage(error) }),
  );
}

/** Stops a task's capture; its last shots are gone, since the run replaced them. */
export function cancelTaskScreens(taskId: string): void {
  if (screens[taskId]?.state !== 'running') return;
  cancelled.add(taskId);
  discardInBackend(taskId);
}

/** A closed task's screens would never be looked at again; up to ~50 MB each, they go. */
function watchTaskClosing(taskId: string): void {
  if (watchers.has(taskId)) return;
  createRoot((dispose) => {
    watchers.set(taskId, dispose);
    createEffect(() => {
      if (isLiveTask(store.tasks[taskId])) return;
      if (screens[taskId]?.state === 'running') cancelled.add(taskId);
      setScreens(taskId, undefined);
      unseen.delete(taskId);
      discardInBackend(taskId);
      watchers.delete(taskId);
      dispose();
    });
  });
}

function finished(taskId: string, name: string, result: CapturedTaskScreens): void {
  // Before the status, which a watching Finish dialog reacts to at once.
  unseen.add(taskId);
  setScreens(taskId, reconcile({ state: 'done', ...result }));
  const message = result.shots.length
    ? `Screenshots of “${name}” are ready.`
    : `No screenshots of “${name}”: ${result.note ?? 'nothing was captured.'}`;
  showNotification(message, {
    durationMs: NOTIFICATION_ERROR_MS,
    action: { label: 'Show', run: () => openTaskReview(taskId) },
  });
}

function failed(taskId: string, error: unknown): void {
  const message = errMessage(error);
  logWarn('taskScreens', 'Capture failed', { taskId, error: message });
  // Kept whole so the user can read all of a long CLI error; the view shortens it.
  setScreens(taskId, reconcile({ state: 'failed', message }));
}

/** Lets the run start the app with the commands it asked about, and only those. */
export function approveTaskScreens(taskId: string): void {
  const status = screens[taskId];
  if (status?.state !== 'running' || !status.commands) return;
  const { commands } = status;
  setScreens(taskId, { ...status, step: 'Starting both versions', commands: undefined });
  invoke(IPC.ApproveTaskScreens, { taskId, ...commands }).catch((error: unknown) => {
    logWarn('taskScreens', 'Approve failed', { error: errMessage(error) });
    // The run still waits; asking again beats showing a start that is not happening.
    asked(taskId, commands);
  });
}

/** The run waits for the user, who may have left the Finish dialog. */
function asked(taskId: string, commands: ServeCommands): void {
  const status = screens[taskId];
  if (status?.state !== 'running') return;
  setScreens(taskId, { ...status, step: 'Waiting for you to start the app', commands });
  showNotification(`Screenshots of “${store.tasks[taskId]?.name}” wait for you to start the app.`, {
    durationMs: NOTIFICATION_ERROR_MS,
    action: { label: 'Show', run: () => openTaskReview(taskId) },
  });
}

/** Shows the run's latest step, or the commands it asks to run, until it ends; returns the unsubscribe. */
function followProgress(taskId: string): () => void {
  // eslint-disable-next-line solid/reactivity -- IPC callback is not a reactive context; it writes our own store
  return window.electron.ipcRenderer.on(IPC.TaskScreensProgress, (data: unknown) => {
    const msg = (data ?? {}) as { taskId?: unknown; step?: unknown; commands?: ServeCommands };
    if (msg.taskId !== taskId) return;
    if (msg.commands) return asked(taskId, msg.commands);
    const status = screens[taskId];
    if (typeof msg.step !== 'string' || status?.state !== 'running') return;
    setScreens(taskId, { ...status, step: msg.step });
  });
}

/**
 * Captures before/after screenshots of a task's interface changes in the
 * background; closing the Finish dialog leaves the run going, closing the task
 * stops it. One capture per task at a time.
 */
export async function captureTaskScreens(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!isLiveTask(task) || screens[taskId]?.state === 'running') return;
  cancelled.delete(taskId);
  unseen.delete(taskId);
  const startedAt = Date.now();
  setScreens(taskId, reconcile({ state: 'running', startedAt }));
  watchTaskClosing(taskId);
  const unfollow = followProgress(taskId);
  // The run shows the code as it is now; a later read of a different diff dates it.
  const code = readTaskDiff(task);
  try {
    const result = await invoke<TaskScreensResult>(IPC.CaptureTaskScreens, {
      taskId,
      worktreePath: task.worktreePath,
      baseBranch: getTaskDiffBaseBranch(task.gitIsolation, task.baseBranch),
      envFile: askCodeEnvFile('claude', store.agentEnvFiles),
      projectId: task.projectId,
    });
    const rawDiff = await code;
    const fingerprint = rawDiff === undefined ? undefined : diffFingerprint(rawDiff);
    if (fingerprint !== undefined) noteCodeFingerprint(taskId, fingerprint, startedAt);
    // A cancel that arrived after the run finished still means the user wanted none.
    if (cancelled.delete(taskId)) {
      if (screens[taskId]) setScreens(taskId, undefined);
      discardInBackend(taskId);
    } else {
      finished(taskId, task.name, { ...result, capturedAt: startedAt, fingerprint });
    }
  } catch (error) {
    if (cancelled.delete(taskId)) {
      if (screens[taskId]) setScreens(taskId, undefined);
    } else if (screens[taskId]) failed(taskId, error);
  } finally {
    unfollow();
  }
}
