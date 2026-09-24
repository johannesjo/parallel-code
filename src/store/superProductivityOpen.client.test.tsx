// The "Start in Parallel Code" flow: a link parked in the main process opens a
// pre-filled New Task form, and the task created from it is linked back.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import type { Task } from './types';
import { linkNewTaskToSp, startSpOpenListener } from './superProductivityOpen';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('../lib/ipc', () => ({ invoke: mockInvoke, Channel: vi.fn() }));

const SP_TASK = {
  id: 'sp-1',
  title: 'Fix login',
  notes: 'Steps to reproduce',
  isDone: false,
  projectId: 'sp-proj',
  parentId: null,
  issueUrl: 'https://github.com/o/r/issues/7',
};

describe('open a Super Productivity task in Parallel Code', () => {
  let pending: string | null;
  let stop: (() => void) | undefined;
  const listeners = new Map<string, () => void>();

  beforeEach(() => {
    pending = 'sp-1';
    listeners.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (channel: string, args?: Record<string, unknown>) => {
      if (channel === IPC.SuperProductivityConsumePendingOpen) {
        const id = pending;
        pending = null;
        return id;
      }
      if (channel === IPC.SuperProductivityGetTask) {
        return args?.taskId === 'sp-1'
          ? { ok: true, value: SP_TASK }
          : { ok: false, reason: 'not_found' };
      }
      if (channel === IPC.SuperProductivityRenameTask) return { ok: true, value: null };
      throw new Error(`unexpected channel ${channel}`);
    });
    window.electron = {
      ipcRenderer: {
        invoke: vi.fn(),
        on: (channel: string, listener: () => void) => {
          listeners.set(channel, listener);
          return () => listeners.delete(channel);
        },
        removeAllListeners: vi.fn(),
      },
      setZoomFactor: vi.fn(),
      getPathForFile: () => '',
    };
    setStore(
      produce((s) => {
        s.tasks = {};
      }),
    );
    setStore('showNewTaskPanel', false);
    setStore('newTaskPrefillPrompt', null);
    setStore('projects', [
      {
        id: 'proj',
        name: 'Proj',
        path: '/repo',
        color: 'red',
        superProductivityProjectId: 'sp-proj',
      },
      { id: 'other', name: 'Other', path: '/other', color: 'blue' },
    ]);
  });

  afterEach(() => stop?.());

  it('pre-fills the New Task form with title, notes, issue link and matched project', async () => {
    stop = startSpOpenListener();
    await vi.waitFor(() => expect(store.showNewTaskPanel).toBe(true));
    expect(store.newTaskPrefillPrompt).toEqual({
      prompt: 'Fix login\n\nSteps to reproduce\n\nhttps://github.com/o/r/issues/7',
      name: 'Fix login',
      projectId: 'proj',
      superProductivity: { taskId: 'sp-1', title: 'Fix login', projectId: 'sp-proj' },
    });
    expect(mockInvoke).toHaveBeenCalledWith(IPC.SuperProductivityGetTask, {
      taskId: 'sp-1',
      includeIssueUrl: true,
    });
  });

  it('opens a link that arrives while running', async () => {
    pending = null;
    stop = startSpOpenListener();
    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(IPC.SuperProductivityConsumePendingOpen),
    );
    expect(store.showNewTaskPanel).toBe(false);
    pending = 'sp-1';
    listeners.get(IPC.SuperProductivityOpenTaskRequested)?.();
    await vi.waitFor(() => expect(store.showNewTaskPanel).toBe(true));
  });

  it('goes to the existing task instead of creating a second one', async () => {
    setStore('tasks', 'a', {
      id: 'a',
      name: 'Fix login',
      agentIds: [],
      superProductivity: { taskId: 'sp-1', syncedTitle: 'Fix login' },
    } as unknown as Task);
    setStore('taskOrder', ['a']);
    stop = startSpOpenListener();
    await vi.waitFor(() => expect(store.activeTaskId).toBe('a'));
    expect(store.showNewTaskPanel).toBe(false);
  });

  it('does not expand a collapsed task (that would restart its agents)', async () => {
    setStore('tasks', 'a', {
      id: 'a',
      name: 'Fix login',
      agentIds: [],
      collapsed: true,
      superProductivity: { taskId: 'sp-1', syncedTitle: 'Fix login' },
    } as unknown as Task);
    stop = startSpOpenListener();
    await vi.waitFor(() =>
      expect(store.notification).toBe('“Fix login” is collapsed in Parallel Code'),
    );
    expect(store.tasks.a.collapsed).toBe(true);
    expect(store.showNewTaskPanel).toBe(false);
  });

  it('links the created task and learns the project pairing', () => {
    setStore('tasks', 'b', { id: 'b', name: 'Fix login' } as Task);
    linkNewTaskToSp('b', { taskId: 'sp-9', title: 'Fix login', projectId: 'sp-other' }, 'other');
    expect(store.tasks.b.superProductivity).toEqual({ taskId: 'sp-9', syncedTitle: 'Fix login' });
    expect(store.projects.find((p) => p.id === 'other')?.superProductivityProjectId).toBe(
      'sp-other',
    );
  });

  it('does not overwrite an existing project pairing', () => {
    setStore('tasks', 'b', { id: 'b', name: 'Fix login' } as Task);
    linkNewTaskToSp('b', { taskId: 'sp-9', title: 'Fix login', projectId: 'sp-else' }, 'proj');
    expect(store.projects.find((p) => p.id === 'proj')?.superProductivityProjectId).toBe('sp-proj');
  });
});
