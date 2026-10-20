import { beforeEach, expect, it, vi } from 'vitest';
import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import { armSpCompletion, fireSpCompletion } from './superProductivity';
import { removeProjectWithTasks } from './project-cleanup';
import { closeTask } from './tasks';
import { removeProject } from './projects';
import type { Task } from './types';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('../lib/ipc', () => ({ invoke: mockInvoke, Channel: vi.fn() }));
vi.mock('./tasks', () => ({ closeTask: vi.fn() }));
vi.mock('./projects', () => ({ removeProject: vi.fn() }));

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue({ ok: true, value: null });
  setStore(
    produce((s) => {
      s.tasks = {
        a: {
          id: 'a',
          name: 'Task a',
          projectId: 'proj',
          branchName: 'task/a',
          worktreePath: '/tmp/a',
          agentIds: [],
          shellAgentIds: [],
          notes: '',
          lastPrompt: '',
          gitIsolation: 'worktree',
          superProductivity: { taskId: 'sp-a', syncedTitle: 'Task a' },
        } satisfies Task,
      };
      s.taskOrder = ['a'];
      s.collapsedTaskOrder = [];
    }),
  );
  // Stands in for a successful close of the only task: removeTaskFromStore
  // fires any armed completion.
  vi.mocked(closeTask).mockImplementation(async (taskId) => {
    fireSpCompletion(taskId);
    setStore(
      produce((s) => {
        delete s.tasks.a;
      }),
    );
  });
});

it('does not complete a linked task armed by an earlier failed close', async () => {
  armSpCompletion('a', { kind: 'closed' });
  await removeProjectWithTasks('proj');
  await Promise.resolve();

  expect(closeTask).toHaveBeenCalledWith('a');
  expect(store.tasks.a).toBeUndefined();
  expect(removeProject).toHaveBeenCalledWith('proj');
  expect(mockInvoke).not.toHaveBeenCalledWith(IPC.SuperProductivityCompleteTask, expect.anything());
});
