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
  terminals?: Record<string, unknown>;
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
  computeTileOrder,
  computeVisibleTaskOrder,
  computeVisualReorder,
  getCoordinatorChildren,
  sortByProjectGroup,
  taskVisualGroupKey,
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

describe('visual tile order', () => {
  it('groups tasks by project, then taskOrder within a project', () => {
    mockStore.projects = [{ id: 'one' }, { id: 'two' }];
    mockStore.tasks = {
      a: { projectId: 'one' },
      b: { projectId: 'two' },
      c: { projectId: 'one' },
    };
    mockStore.taskOrder = ['c', 'a', 'b'];

    expect(computeVisibleTaskOrder()).toEqual(['c', 'a', 'b']);
  });

  it('nests coordinated children directly under their coordinator', () => {
    mockStore.projects = [{ id: 'one' }];
    mockStore.tasks = {
      coord: { projectId: 'one', coordinatorMode: true },
      child: { projectId: 'one', coordinatedBy: 'coord' },
      other: { projectId: 'one' },
    };
    mockStore.taskOrder = ['coord', 'other', 'child'];

    expect(computeVisibleTaskOrder()).toEqual(['coord', 'child', 'other']);
  });

  it('puts orphaned tasks after every project group', () => {
    mockStore.projects = [{ id: 'one' }];
    mockStore.tasks = { a: { projectId: 'one' }, orphan: {} };
    mockStore.taskOrder = ['orphan', 'a'];

    expect(computeVisibleTaskOrder()).toEqual(['a', 'orphan']);
  });

  it('terminates terminal tiles after task tiles, keeping their order', () => {
    mockStore.projects = [{ id: 'one' }];
    mockStore.tasks = { a: { projectId: 'one' } };
    mockStore.taskOrder = ['term-1', 'a', 'term-2'];
    mockStore.terminals = { 'term-1': {}, 'term-2': {} };

    expect(computeTileOrder()).toEqual(['a', 'term-1', 'term-2']);
  });

  it("leaves a single project's tile order exactly as stored", () => {
    mockStore.projects = [{ id: 'one' }];
    mockStore.tasks = { a: { projectId: 'one' }, b: { projectId: 'one' }, c: { projectId: 'one' } };
    mockStore.taskOrder = ['c', 'a', 'b'];

    expect(computeTileOrder()).toEqual(['c', 'a', 'b']);
  });

  it('sorts a coordinated child next to its coordinator, as the tiles show it', () => {
    mockStore.projects = [{ id: 'one' }];
    mockStore.tasks = {
      coord: { projectId: 'one', coordinatorMode: true },
      a: { projectId: 'one' },
      child: { projectId: 'one', coordinatedBy: 'coord' },
    };
    // Spawned children are appended to the raw order.
    expect(sortByProjectGroup(['coord', 'a', 'child'])).toEqual(['coord', 'child', 'a']);
  });

  it('sorts any id list into project groups, then orphans, then terminals', () => {
    mockStore.projects = [{ id: 'one' }, { id: 'two' }];
    mockStore.tasks = {
      a: { projectId: 'two' },
      b: { projectId: 'one' },
      orphan: {},
      c: { projectId: 'one' },
    };
    mockStore.terminals = { term: {} };

    expect(sortByProjectGroup(['term', 'a', 'orphan', 'b', 'c'])).toEqual([
      'b',
      'c',
      'a',
      'orphan',
      'term',
    ]);
  });

  it('keeps tasks of a collapsed project group in the tile order', () => {
    mockStore.projects = [{ id: 'one', tasksCollapsed: true }];
    mockStore.tasks = { a: { projectId: 'one' } };
    mockStore.taskOrder = ['a'];

    expect(computeVisibleTaskOrder()).toEqual(['a']);
  });
});

describe('visual reorder', () => {
  it('keeps a moved block inside its own project group', () => {
    mockStore.projects = [{ id: 'one' }, { id: 'two' }];
    mockStore.tasks = {
      a: { projectId: 'one' },
      b: { projectId: 'two' },
      c: { projectId: 'one' },
    };
    mockStore.taskOrder = ['a', 'b', 'c'];
    const order = ['a', 'c', 'b'];

    // A drop at the very end lands past another group: ignored.
    expect(computeVisualReorder(order, 'a', 2)).toBeNull();
    expect(computeVisualReorder(order, 'c', 2)).toBeNull();
    // Within group: move a to the end of its own group (before b, group two).
    expect(computeVisualReorder(order, 'a', 1)).toEqual(['b', 'c', 'a']);
    // Move c to the start of group one.
    expect(computeVisualReorder(order, 'c', 0)).toEqual(['c', 'a', 'b']);
  });

  it('returns null for cross-group drops without mutating', () => {
    mockStore.projects = [{ id: 'one' }, { id: 'two' }];
    mockStore.tasks = {
      a: { projectId: 'one' },
      b: { projectId: 'two' },
    };
    mockStore.taskOrder = ['a', 'b'];

    expect(computeVisualReorder(['a', 'b'], 'a', 1)).toBeNull();
    expect(computeVisualReorder(['a', 'b'], 'b', 0)).toBeNull();
  });

  it('moves a coordinator together with its active children', () => {
    mockStore.projects = [{ id: 'one' }];
    mockStore.tasks = {
      coord: { projectId: 'one', coordinatorMode: true },
      child: { projectId: 'one', coordinatedBy: 'coord' },
      other: { projectId: 'one' },
    };
    mockStore.taskOrder = ['other', 'coord', 'child'];

    const next = computeVisualReorder(['other', 'coord', 'child'], 'coord', 0);
    expect(next).toEqual(['coord', 'child', 'other']);
  });

  it('drops a dragged coordinator block where its tile was released', () => {
    mockStore.projects = [{ id: 'one' }];
    mockStore.tasks = {
      coord: { projectId: 'one', coordinatorMode: true },
      child: { projectId: 'one', coordinatedBy: 'coord' },
      a: { projectId: 'one' },
      b: { projectId: 'one' },
    };
    mockStore.taskOrder = ['coord', 'child', 'a', 'b'];

    // Released between a and b; the drag counts the target with only coord removed.
    expect(computeVisualReorder(['coord', 'child', 'a', 'b'], 'coord', 2)).toEqual([
      'a',
      'coord',
      'child',
      'b',
    ]);
  });

  it('moves a task in front of a coordinator block, not between it and its child', () => {
    mockStore.projects = [{ id: 'one' }];
    mockStore.tasks = {
      coord: { projectId: 'one', coordinatorMode: true },
      child: { projectId: 'one', coordinatedBy: 'coord' },
      a: { projectId: 'one' },
      b: { projectId: 'one' },
    };
    mockStore.taskOrder = ['coord', 'child', 'a', 'b'];

    // Moving a left lands its target on the child; the whole block must step aside.
    expect(computeVisualReorder(['coord', 'child', 'a', 'b'], 'a', 1)).toEqual([
      'a',
      'coord',
      'child',
      'b',
    ]);
  });

  it('drops after the whole last block when its child is stored before its coordinator', () => {
    mockStore.projects = [{ id: 'one' }];
    mockStore.tasks = {
      coord: { projectId: 'one', coordinatorMode: true },
      child: { projectId: 'one', coordinatedBy: 'coord' },
      a: { projectId: 'one' },
      b: { projectId: 'one' },
    };
    // An uncollapsed coordinator is appended, so it can follow its own child.
    mockStore.taskOrder = ['child', 'a', 'b', 'coord'];

    const next = computeVisualReorder(['a', 'b', 'coord', 'child'], 'a', 3);
    mockStore.taskOrder = next ?? [];
    expect(computeVisibleTaskOrder()).toEqual(['b', 'coord', 'child', 'a']);
  });

  it('keeps terminals grouped after tasks when reordering', () => {
    mockStore.projects = [{ id: 'one' }];
    mockStore.tasks = { a: { projectId: 'one' } };
    mockStore.taskOrder = ['a', 'term-1', 'term-2'];
    mockStore.terminals = { 'term-1': {}, 'term-2': {} };

    expect(computeVisualReorder(['a', 'term-1', 'term-2'], 'term-1', 2)).toEqual([
      'a',
      'term-2',
      'term-1',
    ]);
    expect(computeVisualReorder(['a', 'term-1', 'term-2'], 'a', 2)).toBeNull();
  });
});

describe('group helpers', () => {
  it('taskVisualGroupKey separates tasks, orphans and terminals', () => {
    mockStore.projects = [{ id: 'one' }];
    mockStore.tasks = { a: { projectId: 'one' }, orphan: {} };
    mockStore.terminals = { term: {} };

    expect(taskVisualGroupKey('a')).toBe('one');
    expect(taskVisualGroupKey('orphan')).toBe('__orphan__');
    expect(taskVisualGroupKey('term')).toBeNull();
  });
});
