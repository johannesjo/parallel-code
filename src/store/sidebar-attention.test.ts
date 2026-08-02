import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefined, type MockStoreHarness } from './test-helpers';
import type { TaskAttentionState } from './taskStatus';

type MockStore = {
  tasks: Record<string, object>;
  taskOrder: string[];
  collapsedTaskOrder: string[];
};

const core = vi.hoisted(() => ({
  harness: undefined as MockStoreHarness<MockStore> | undefined,
}));

const status = vi.hoisted(() => ({
  attention: new Map<string, string>(),
  since: new Map<string, number>(),
}));

vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness<MockStore>({
    tasks: {},
    taskOrder: [],
    collapsedTaskOrder: [],
  });
  return core.harness.moduleMock();
});

vi.mock('./taskStatus', () => ({
  getTaskAttentionState: (taskId: string) =>
    (status.attention.get(taskId) ?? 'idle') as TaskAttentionState,
  getTaskQuestionSince: (taskId: string) => status.since.get(taskId) ?? null,
}));

import { computeNeedsInputTasks } from './sidebar-attention';

let mockStore: MockStore;

beforeEach(() => {
  const harness = expectDefined(core.harness, 'mock store harness');
  mockStore = harness.reset({ tasks: {}, taskOrder: [], collapsedTaskOrder: [] });
  status.attention.clear();
  status.since.clear();
});

describe('computeNeedsInputTasks', () => {
  it('returns only tasks waiting on an answer, newest question first', () => {
    mockStore.taskOrder = ['task-1', 'task-2', 'task-3'];
    mockStore.tasks = { 'task-1': {}, 'task-2': {}, 'task-3': {} };
    status.attention.set('task-1', 'needs_input');
    status.attention.set('task-2', 'active');
    status.attention.set('task-3', 'needs_input');
    status.since.set('task-1', 1_000);
    status.since.set('task-3', 5_000);

    expect(computeNeedsInputTasks()).toEqual([
      { taskId: 'task-3', since: 5_000 },
      { taskId: 'task-1', since: 1_000 },
    ]);
  });

  it('includes collapsed tasks and sinks unknown timestamps to the bottom', () => {
    mockStore.taskOrder = ['task-1'];
    mockStore.collapsedTaskOrder = ['task-2'];
    mockStore.tasks = { 'task-1': {}, 'task-2': {} };
    status.attention.set('task-1', 'needs_input');
    status.attention.set('task-2', 'needs_input');
    status.since.set('task-2', 9_000);

    expect(computeNeedsInputTasks()).toEqual([
      { taskId: 'task-2', since: 9_000 },
      { taskId: 'task-1', since: null },
    ]);
  });

  it('skips ids with no task and never lists a task twice', () => {
    mockStore.taskOrder = ['task-1', 'ghost'];
    mockStore.collapsedTaskOrder = ['task-1'];
    mockStore.tasks = { 'task-1': {} };
    status.attention.set('task-1', 'needs_input');
    status.attention.set('ghost', 'needs_input');
    status.since.set('task-1', 42);

    expect(computeNeedsInputTasks()).toEqual([{ taskId: 'task-1', since: 42 }]);
  });
});
