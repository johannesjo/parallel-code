import { createEffect, onCleanup, type Accessor } from 'solid-js';
import { store } from './store';
import { getTaskAttentionState, type TaskAttentionState } from './taskStatus';
import { setActiveTask } from './navigation';
import { fireAndForget } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';

const DEBOUNCE_MS = 3_000;

type NotificationType = 'ready' | 'needs_input' | 'error';

export function startDesktopNotificationWatcher(windowFocused: Accessor<boolean>): () => void {
  const previousAttention = new Map<string, TaskAttentionState>();
  // Map keyed by taskId — naturally deduplicates and last transition wins.
  // If a task goes needs_input→error→ready within the debounce window, only
  // the last meaningful notification is kept.
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
    const needsInput = items.filter(([, type]) => type === 'needs_input');
    const errored = items.filter(([, type]) => type === 'error');

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
      if (prev === undefined) continue;
      if (prev === current) continue;

      if (current === 'ready' && prev !== 'ready') {
        scheduleBatch('ready', taskId);
      } else if (current === 'needs_input' && prev !== 'needs_input') {
        scheduleBatch('needs_input', taskId);
      } else if (current === 'error' && prev !== 'error') {
        scheduleBatch('error', taskId);
      }
    }

    // Clean up removed tasks
    for (const taskId of previousAttention.keys()) {
      if (!seen.has(taskId)) previousAttention.delete(taskId);
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
