import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefined, type MockStoreHarness } from './test-helpers';

type MockTask = {
  projectId?: string;
  coordinatorMode?: boolean;
  coordinatedBy?: string;
  collapsed?: boolean;
};
type MockStore = {
  taskProjectFilter?: string | null;
  tasks: Record<string, MockTask>;
  taskOrder: string[];
  collapsedTaskOrder: string[];
  projects: Array<{ id: string; tasksCollapsed?: boolean }>;
};

const core = vi.hoisted(() => ({
  harness: undefined as MockStoreHarness<MockStore> | undefined,
}));
let mockStore: MockStore;

vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness<MockStore>({
    tasks: {},
    taskOrder: [],
    collapsedTaskOrder: [],
    projects: [],
  });
  return core.harness.moduleMock();
});

import {
  computeSidebarDraggableTaskOrder,
  computeGroupedTasks,
  computeSidebarTaskOrder,
  getCoordinatorChildren,
} from './sidebar-order';

beforeEach(() => {
  const harness = expectDefined(core.harness, 'mock store harness');
  mockStore = harness.reset({
    tasks: {},
    taskOrder: [],
    collapsedTaskOrder: [],
    projects: [],
  });
});

describe('sidebar coordinator ordering', () => {
  it('groups coordinator children only under their coordinator', () => {
    mockStore.projects = [{ id: 'proj-1' }];
    mockStore.taskOrder = ['coord-1', 'child-1', 'task-1'];
    mockStore.collapsedTaskOrder = ['child-2'];
    mockStore.tasks = {
      'coord-1': { projectId: 'proj-1', coordinatorMode: true },
      'child-1': { projectId: 'proj-1', coordinatedBy: 'coord-1' },
      'child-2': { projectId: 'proj-1', coordinatedBy: 'coord-1', collapsed: true },
      'task-1': { projectId: 'proj-1' },
    };

    expect(getCoordinatorChildren('coord-1')).toEqual({
      active: ['child-1'],
      collapsed: ['child-2'],
    });
    expect(computeGroupedTasks().grouped['proj-1']).toEqual({
      active: ['coord-1', 'task-1'],
      collapsed: [],
    });
  });

  it('includes visible nested subtasks in keyboard navigation order', () => {
    mockStore.projects = [{ id: 'proj-1' }];
    mockStore.taskOrder = ['coord-1', 'child-1', 'task-1'];
    mockStore.collapsedTaskOrder = ['child-2'];
    mockStore.tasks = {
      'coord-1': { projectId: 'proj-1', coordinatorMode: true },
      'child-1': { projectId: 'proj-1', coordinatedBy: 'coord-1' },
      'child-2': { projectId: 'proj-1', coordinatedBy: 'coord-1', collapsed: true },
      'task-1': { projectId: 'proj-1' },
    };

    expect(computeSidebarTaskOrder()).toEqual(['coord-1', 'child-1', 'child-2', 'task-1']);
    expect(computeSidebarDraggableTaskOrder()).toEqual(['coord-1', 'task-1']);
  });

  it('omits tasks in collapsed project groups from keyboard navigation', () => {
    mockStore.projects = [{ id: 'proj-1', tasksCollapsed: true }, { id: 'proj-2' }];
    mockStore.taskOrder = ['task-1', 'task-2'];
    mockStore.tasks = {
      'task-1': { projectId: 'proj-1' },
      'task-2': { projectId: 'proj-2' },
    };

    expect(computeSidebarTaskOrder()).toEqual(['task-2']);
    expect(computeSidebarDraggableTaskOrder()).toEqual(['task-2']);
  });
});

describe('project filtering', () => {
  it('filters active, collapsed, orphaned and keyboard/drag task lists', () => {
    mockStore.projects = [{ id: 'one' }, { id: 'two' }];
    mockStore.tasks = {
      a: { projectId: 'one' },
      b: { projectId: 'two' },
      c: { projectId: 'two', collapsed: true },
      orphan: {},
    };
    mockStore.taskOrder = ['a', 'b', 'orphan'];
    mockStore.collapsedTaskOrder = ['c'];
    mockStore.taskProjectFilter = 'two';
    expect(computeSidebarTaskOrder()).toEqual(['b', 'c']);
    expect(computeSidebarDraggableTaskOrder()).toEqual(['b']);
    expect(computeGroupedTasks().orphanedActive).toEqual([]);
    mockStore.taskProjectFilter = null;
    expect(computeSidebarTaskOrder()).toEqual(['a', 'b', 'c', 'orphan']);
  });

  it('falls back to all tasks if the filtered project is removed', () => {
    mockStore.projects = [{ id: 'one' }];
    mockStore.tasks = { a: { projectId: 'one' } };
    mockStore.taskOrder = ['a'];
    mockStore.taskProjectFilter = 'removed';
    expect(computeSidebarTaskOrder()).toEqual(['a']);
  });
});
