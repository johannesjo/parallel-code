import { createEffect, onCleanup, type Accessor } from 'solid-js';
import { store } from './store';
import { getTaskDotStatus, type TaskDotStatus } from './taskStatus';
import { setActiveTask } from './navigation';
import { IPC } from '../../electron/ipc/channels';

const DEBOUNCE_MS = 3_000;

interface PendingNotification {
  type: 'ready' | 'waiting';
  taskId: string;
}

export function startDesktopNotificationWatcher(windowFocused: Accessor<boolean>): () => void {
  const previousStatus = new Map<string, TaskDotStatus>();
  let pending: PendingNotification[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function flushNotifications(): void {
    debounceTimer = undefined;
    if (windowFocused() || pending.length === 0) {
      pending = [];
      return;
    }

    const ready = pending.filter((n) => n.type === 'ready');
    const waiting = pending.filter((n) => n.type === 'waiting');
    pending = [];

    if (ready.length > 0) {
      const taskIds = ready.map((n) => n.taskId);
      const body =
        ready.length === 1
          ? `${taskName(taskIds[0])} is ready for review`
          : `${ready.length} tasks ready for review`;
      window.electron.ipcRenderer.send(IPC.ShowNotification, {
        title: 'Task Ready',
        body,
        taskIds,
      });
    }

    if (waiting.length > 0) {
      const taskIds = waiting.map((n) => n.taskId);
      const body =
        waiting.length === 1
          ? `${taskName(taskIds[0])} needs your attention`
          : `${waiting.length} tasks need your attention`;
      window.electron.ipcRenderer.send(IPC.ShowNotification, {
        title: 'Task Waiting',
        body,
        taskIds,
      });
    }
  }

  function taskName(taskId: string): string {
    return store.tasks[taskId]?.name ?? taskId;
  }

  function scheduleBatch(notification: PendingNotification): void {
    if (!store.desktopNotificationsEnabled) return;
    pending.push(notification);
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
        scheduleBatch({ type: 'ready', taskId });
      } else if (current === 'waiting' && prev === 'busy') {
        scheduleBatch({ type: 'waiting', taskId });
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
      pending = [];
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
