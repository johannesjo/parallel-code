import { createEffect, onCleanup, type Accessor } from 'solid-js';
import { store } from './store';
import { getTaskDotStatus, type TaskDotStatus } from './taskStatus';
import { setActiveTask } from './navigation';
import { fireAndForget } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';

const DEBOUNCE_MS = 3_000;

type NotificationType = 'ready' | 'waiting';

export function startDesktopNotificationWatcher(windowFocused: Accessor<boolean>): () => void {
  const previousStatus = new Map<string, TaskDotStatus>();
  // Map keyed by taskId — naturally deduplicates and last transition wins.
  // If a task goes busy→waiting→ready within the debounce window, only
  // 'ready' is kept, avoiding contradictory notifications.
  let pending = new Map<string, NotificationType>();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function flushNotifications(): void {
    debounceTimer = undefined;
    if (!store.desktopNotificationsEnabled || windowFocused() || pending.size === 0) {
      pending = new Map();
      return;
    }

    const items = [...pending.entries()];
    pending = new Map();

    const ready = items.filter(([, type]) => type === 'ready');
    const waiting = items.filter(([, type]) => type === 'waiting');

    if (ready.length > 0) {
      const taskIds = ready.map(([id]) => id);
      const body =
        ready.length === 1
          ? `${taskName(taskIds[0])} is ready for review`
          : `${ready.length} tasks ready for review`;
      fireAndForget(IPC.ShowNotification, { title: 'Task Ready', body, taskIds });
    }

    if (waiting.length > 0) {
      const taskIds = waiting.map(([id]) => id);
      const body =
        waiting.length === 1
          ? `${taskName(taskIds[0])} needs your attention`
          : `${waiting.length} tasks need your attention`;
      fireAndForget(IPC.ShowNotification, { title: 'Task Waiting', body, taskIds });
    }
  }

  function taskName(taskId: string): string {
    return store.tasks[taskId]?.name ?? taskId;
  }

  function scheduleBatch(type: NotificationType, taskId: string): void {
    if (!store.desktopNotificationsEnabled) return;
    pending.set(taskId, type);
    if (debounceTimer === undefined) {
      debounceTimer = setTimeout(flushNotifications, DEBOUNCE_MS);
    }
  }

  // Track status transitions
  createEffect(() => {
    const allTaskIds = [...store.taskOrder, ...store.collapsedTaskOrder];
    const seen = new Set<string>();

    for (const taskId of allTaskIds) {
      seen.add(taskId);
      const current = getTaskDotStatus(taskId);
      const prev = previousStatus.get(taskId);
      previousStatus.set(taskId, current);

      // Skip initial population
      if (prev === undefined) continue;
      if (prev === current) continue;

      if (current === 'ready' && prev !== 'ready') {
        scheduleBatch('ready', taskId);
      } else if (current === 'waiting' && prev === 'busy') {
        scheduleBatch('waiting', taskId);
      }
    }

    // Clean up removed tasks
    for (const taskId of previousStatus.keys()) {
      if (!seen.has(taskId)) previousStatus.delete(taskId);
    }
  });

  // Clear pending when window regains focus
  createEffect(() => {
    if (windowFocused()) {
      pending = new Map();
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

  const cleanup = (): void => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    offNotificationClicked();
  };

  onCleanup(cleanup);
  return cleanup;
}
