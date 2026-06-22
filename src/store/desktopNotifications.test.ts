import { createRoot } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearShownDesktopNotificationsForTask,
  clearPendingNotification,
  rememberShownDesktopNotifications,
  reconcilePendingNotification,
  shouldQueueDesktopNotification,
  shouldShowDesktopNotification,
  shouldShowDesktopNotificationForTask,
  startDesktopNotificationWatcher,
  type NotificationType,
} from './desktopNotifications';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reconcilePendingNotification', () => {
  it('drops a queued notification when the task recovers before flush', () => {
    const pending = new Map<string, NotificationType>([['task-1', 'error']]);

    const result = reconcilePendingNotification(pending, 'task-1', 'error', 'active');

    expect(result).toBeNull();
    expect(pending.has('task-1')).toBe(false);
  });

  it('keeps scheduling real error transitions', () => {
    const pending = new Map<string, NotificationType>();

    const result = reconcilePendingNotification(pending, 'task-1', 'active', 'error');

    expect(result).toBe('error');
  });

  it('does not notify during initial population', () => {
    const pending = new Map<string, NotificationType>();

    const result = reconcilePendingNotification(pending, 'task-1', undefined, 'error');

    expect(result).toBeNull();
    expect(pending.has('task-1')).toBe(false);
  });

  it('drops queued notifications for removed tasks', () => {
    const pending = new Map<string, NotificationType>([['task-1', 'error']]);

    clearPendingNotification(pending, 'task-1');

    expect(pending.has('task-1')).toBe(false);
  });
});

describe('shouldShowDesktopNotification', () => {
  it('keeps generic notifications for standalone tasks', () => {
    expect(shouldShowDesktopNotification('ready', undefined)).toBe(true);
    expect(shouldShowDesktopNotification('error', undefined)).toBe(true);
    expect(shouldShowDesktopNotification('needs_input', undefined)).toBe(true);
  });

  it('suppresses generic review and error notifications for coordinated subtasks', () => {
    expect(shouldShowDesktopNotification('ready', 'coordinator-task')).toBe(false);
    expect(shouldShowDesktopNotification('error', 'coordinator-task')).toBe(false);
  });

  it('keeps input-needed notifications for coordinated subtasks', () => {
    expect(shouldShowDesktopNotification('needs_input', 'coordinator-task')).toBe(true);
  });
});

describe('shouldShowDesktopNotificationForTask', () => {
  it('keeps ready notifications for normal tasks', () => {
    expect(
      shouldShowDesktopNotificationForTask(
        'ready',
        'task-1',
        {
          'task-1': { agentIds: ['agent-1'], shellAgentIds: [] },
        },
        {
          'agent-1': { status: 'exited' },
        },
      ),
    ).toBe(true);
  });

  it('suppresses coordinator ready notifications while a coordinated child has a running agent', () => {
    expect(
      shouldShowDesktopNotificationForTask(
        'ready',
        'coordinator-1',
        {
          'coordinator-1': { agentIds: ['coordinator-agent'], shellAgentIds: [] },
          'child-1': {
            coordinatedBy: 'coordinator-1',
            agentIds: ['child-agent'],
            shellAgentIds: [],
          },
        },
        {
          'coordinator-agent': { status: 'running' },
          'child-agent': { status: 'running' },
        },
      ),
    ).toBe(false);
  });

  it('allows coordinator ready notifications after coordinated child agents have exited', () => {
    expect(
      shouldShowDesktopNotificationForTask(
        'ready',
        'coordinator-1',
        {
          'coordinator-1': { agentIds: ['coordinator-agent'], shellAgentIds: [] },
          'child-1': {
            coordinatedBy: 'coordinator-1',
            agentIds: ['child-agent'],
            shellAgentIds: [],
          },
        },
        {
          'coordinator-agent': { status: 'running' },
          'child-agent': { status: 'exited' },
        },
      ),
    ).toBe(true);
  });
});

describe('desktop notification dedupe', () => {
  it('does not queue a notification already shown while unfocused', () => {
    const shown = new Set<string>();
    rememberShownDesktopNotifications(shown, [['task-1', 'ready']]);

    expect(
      shouldQueueDesktopNotification(
        'ready',
        'task-1',
        { 'task-1': { agentIds: [], shellAgentIds: [] } },
        {},
        shown,
      ),
    ).toBe(false);
  });

  it('still queues a different notification type for the same task', () => {
    const shown = new Set<string>();
    rememberShownDesktopNotifications(shown, [['task-1', 'ready']]);

    expect(
      shouldQueueDesktopNotification(
        'needs_input',
        'task-1',
        { 'task-1': { agentIds: [], shellAgentIds: [] } },
        {},
        shown,
      ),
    ).toBe(true);
  });

  it('can reset dedupe state when the task is removed or the window regains focus', () => {
    const shown = new Set<string>();
    rememberShownDesktopNotifications(shown, [
      ['task-1', 'ready'],
      ['task-1', 'needs_input'],
    ]);

    clearShownDesktopNotificationsForTask(shown, 'task-1');

    expect(
      shouldQueueDesktopNotification(
        'ready',
        'task-1',
        { 'task-1': { agentIds: [], shellAgentIds: [] } },
        {},
        shown,
      ),
    ).toBe(true);
    expect(
      shouldQueueDesktopNotification(
        'needs_input',
        'task-1',
        { 'task-1': { agentIds: [], shellAgentIds: [] } },
        {},
        shown,
      ),
    ).toBe(true);
  });
});

describe('startDesktopNotificationWatcher', () => {
  it('replaces an existing watcher instead of stacking duplicate listeners', () => {
    const offClickFirst = vi.fn();
    const offClickSecond = vi.fn();
    const offFailFirst = vi.fn();
    const offFailSecond = vi.fn();
    const on = vi
      .fn()
      .mockReturnValueOnce(offClickFirst) // first watcher: NotificationClicked
      .mockReturnValueOnce(offFailFirst) // first watcher: NotificationFailed
      .mockReturnValueOnce(offClickSecond) // second watcher: NotificationClicked
      .mockReturnValueOnce(offFailSecond); // second watcher: NotificationFailed
    vi.stubGlobal('window', {
      electron: {
        ipcRenderer: {
          on,
        },
      },
    });

    createRoot((dispose) => {
      const stopFirst = startDesktopNotificationWatcher(() => false);
      // First watcher's listeners should not be cleaned up yet
      expect(offClickFirst).not.toHaveBeenCalled();
      expect(offFailFirst).not.toHaveBeenCalled();

      const stopSecond = startDesktopNotificationWatcher(() => false);
      // Starting a second watcher should clean up the first watcher's listeners
      expect(offClickFirst).toHaveBeenCalledTimes(1);
      expect(offFailFirst).toHaveBeenCalledTimes(1);
      expect(offClickSecond).not.toHaveBeenCalled();
      expect(offFailSecond).not.toHaveBeenCalled();

      stopFirst();
      expect(offClickFirst).toHaveBeenCalledTimes(1);
      expect(offFailFirst).toHaveBeenCalledTimes(1);

      stopSecond();
      expect(offClickSecond).toHaveBeenCalledTimes(1);
      expect(offFailSecond).toHaveBeenCalledTimes(1);

      dispose();
    });
  });
});
