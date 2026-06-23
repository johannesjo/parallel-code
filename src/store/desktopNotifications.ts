import { createEffect, onCleanup, type Accessor } from 'solid-js';
import { store } from './store';
import { getTaskAttentionState, type TaskAttentionState } from './taskStatus';
import { setActiveTask } from './navigation';
import { fireAndForget } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { Agent, Task } from './types';

const DEBOUNCE_MS = 3_000;

export type NotificationType = 'ready' | 'needs_input' | 'error';
const NOTIFICATION_TYPES: NotificationType[] = ['ready', 'needs_input', 'error'];
let activeDesktopNotificationWatcherCleanup: (() => void) | undefined;

export function shouldShowDesktopNotification(
  type: NotificationType,
  coordinatedBy: string | undefined,
): boolean {
  if (!coordinatedBy) return true;
  return type === 'needs_input';
}

type DesktopNotificationTask = Pick<Task, 'coordinatedBy' | 'agentIds' | 'shellAgentIds'>;
type DesktopNotificationAgent = Pick<Agent, 'status'>;

function taskHasRunningAgent(
  task: DesktopNotificationTask,
  agents: Readonly<Record<string, DesktopNotificationAgent | undefined>>,
): boolean {
  return [...(task.agentIds ?? []), ...(task.shellAgentIds ?? [])].some(
    (agentId) => agents[agentId]?.status === 'running',
  );
}

export function hasRunningCoordinatedChild(
  taskId: string,
  tasks: Readonly<Record<string, DesktopNotificationTask | undefined>>,
  agents: Readonly<Record<string, DesktopNotificationAgent | undefined>>,
): boolean {
  return Object.values(tasks).some(
    (task) => task?.coordinatedBy === taskId && taskHasRunningAgent(task, agents),
  );
}

export function shouldShowDesktopNotificationForTask(
  type: NotificationType,
  taskId: string,
  tasks: Readonly<Record<string, DesktopNotificationTask | undefined>>,
  agents: Readonly<Record<string, DesktopNotificationAgent | undefined>>,
): boolean {
  const task = tasks[taskId];
  if (!task) return false;
  if (!shouldShowDesktopNotification(type, task.coordinatedBy)) return false;
  return type !== 'ready' || !hasRunningCoordinatedChild(taskId, tasks, agents);
}

function notificationKey(taskId: string, type: NotificationType): string {
  return `${taskId}:${type}`;
}

export function shouldQueueDesktopNotification(
  type: NotificationType,
  taskId: string,
  tasks: Readonly<Record<string, DesktopNotificationTask | undefined>>,
  agents: Readonly<Record<string, DesktopNotificationAgent | undefined>>,
  shown: ReadonlySet<string>,
): boolean {
  return (
    shouldShowDesktopNotificationForTask(type, taskId, tasks, agents) &&
    !shown.has(notificationKey(taskId, type))
  );
}

export function rememberShownDesktopNotifications(
  shown: Set<string>,
  items: Array<[string, NotificationType]>,
): void {
  for (const [taskId, type] of items) {
    shown.add(notificationKey(taskId, type));
  }
}

export function clearShownDesktopNotificationsForTask(shown: Set<string>, taskId: string): void {
  for (const type of NOTIFICATION_TYPES) {
    shown.delete(notificationKey(taskId, type));
  }
}

export function reconcilePendingNotification(
  pending: Map<string, NotificationType>,
  taskId: string,
  previous: TaskAttentionState | undefined,
  current: TaskAttentionState,
): NotificationType | null {
  if (previous === undefined || previous === current) return null;
  if (current === 'ready') return 'ready';
  if (current === 'needs_input') return 'needs_input';
  if (current === 'error') return 'error';
  pending.delete(taskId);
  return null;
}

export function clearPendingNotification(
  pending: Map<string, NotificationType>,
  taskId: string,
): void {
  pending.delete(taskId);
}

export function startDesktopNotificationWatcher(windowFocused: Accessor<boolean>): () => void {
  activeDesktopNotificationWatcherCleanup?.();

  const previousAttention = new Map<string, TaskAttentionState>();
  // Map keyed by taskId — naturally deduplicates and last transition wins.
  // If a task goes needs_input→error→ready within the debounce window, only
  // the last meaningful notification is kept.
  let pending = new Map<string, NotificationType>();
  const shownWhileUnfocused = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function flushNotifications(): void {
    debounceTimer = undefined;
    if (!store.desktopNotificationsEnabled || windowFocused() || pending.size === 0) {
      pending = new Map();
      return;
    }

    const items = [...pending.entries()].filter(([taskId, type]) =>
      shouldShowDesktopNotificationForTask(type, taskId, store.tasks, store.agents),
    );
    pending = new Map();

    const ready = items.filter(([, type]) => type === 'ready');
    const needsInput = items.filter(([, type]) => type === 'needs_input');
    const errored = items.filter(([, type]) => type === 'error');
    rememberShownDesktopNotifications(shownWhileUnfocused, items);

    if (ready.length > 0) {
      const taskIds = ready.map(([id]) => id);
      const body =
        ready.length === 1
          ? `${taskName(taskIds[0])} is ready for review`
          : `${ready.length} tasks ready for review`;
      fireAndForget(IPC.ShowNotification, { title: 'Task Ready', body, taskIds });
    }

    if (needsInput.length > 0) {
      const taskIds = needsInput.map(([id]) => id);
      const body =
        needsInput.length === 1
          ? `${taskName(taskIds[0])} needs your input`
          : `${needsInput.length} tasks need your input`;
      fireAndForget(IPC.ShowNotification, { title: 'Task Needs Input', body, taskIds });
    }

    if (errored.length > 0) {
      const taskIds = errored.map(([id]) => id);
      const body =
        errored.length === 1
          ? `${taskName(taskIds[0])} encountered an error`
          : `${errored.length} tasks encountered errors`;
      fireAndForget(IPC.ShowNotification, { title: 'Task Error', body, taskIds });
    }
  }

  function taskName(taskId: string): string {
    return store.tasks[taskId]?.name ?? taskId;
  }

  function scheduleBatch(type: NotificationType, taskId: string): void {
    if (!store.desktopNotificationsEnabled) return;
    if (
      !shouldQueueDesktopNotification(type, taskId, store.tasks, store.agents, shownWhileUnfocused)
    ) {
      return;
    }
    pending.set(taskId, type);
    if (debounceTimer === undefined) {
      debounceTimer = setTimeout(flushNotifications, DEBOUNCE_MS);
    }
  }

  // Track attention transitions
  createEffect(() => {
    const allTaskIds = [...store.taskOrder, ...store.collapsedTaskOrder];
    const seen = new Set<string>();

    for (const taskId of allTaskIds) {
      seen.add(taskId);
      const current = getTaskAttentionState(taskId);
      const prev = previousAttention.get(taskId);
      previousAttention.set(taskId, current);

      // Skip initial population
      const notificationType = reconcilePendingNotification(pending, taskId, prev, current);
      if (notificationType) scheduleBatch(notificationType, taskId);
    }

    // Clean up removed tasks
    for (const taskId of previousAttention.keys()) {
      if (!seen.has(taskId)) {
        previousAttention.delete(taskId);
        clearPendingNotification(pending, taskId);
        clearShownDesktopNotificationsForTask(shownWhileUnfocused, taskId);
      }
    }
  });

  // Clear pending when window regains focus
  createEffect(() => {
    if (windowFocused()) {
      pending = new Map();
      shownWhileUnfocused.clear();
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
    }
  });

  // Listen for notification clicks from main process
  const offNotificationClicked = window.electron.ipcRenderer.on(
    IPC.NotificationClicked,
    (data: unknown) => {
      const msg = data as Record<string, unknown>;
      const taskIds = Array.isArray(msg?.taskIds) ? (msg.taskIds as string[]) : [];
      if (taskIds.length) {
        setActiveTask(taskIds[0]);
      }
    },
  );

  // Surface notification failures to the UI.
  // NOTE: The `failed` event only fires on macOS from Electron 42+ (UNNotification
  // migration). On the current Electron 40, this path is macOS-inert — it fires
  // on Windows only. After an Electron 42 upgrade, unsigned macOS builds will
  // trigger this handler, letting the user know notifications need code-signing.
  const offNotificationFailed = window.electron.ipcRenderer.on(
    IPC.NotificationFailed,
    (data: unknown) => {
      const msg = data as Record<string, unknown>;
      if (msg?.platform === 'darwin') {
        // Visible in the renderer console (DevTools). A future follow-up can
        // add a toast/banner when the design for settings-level alerts lands.
        console.warn(
          '[notifications] macOS notification delivery failed. Unsigned dev builds need ' +
            'ad-hoc code-signing (codesign --force --deep -s - <app>). Error:',
          msg?.error,
        );
      }
    },
  );

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    offNotificationClicked();
    offNotificationFailed();
    if (activeDesktopNotificationWatcherCleanup === cleanup) {
      activeDesktopNotificationWatcherCleanup = undefined;
    }
  };

  activeDesktopNotificationWatcherCleanup = cleanup;
  onCleanup(cleanup);
  return cleanup;
}
