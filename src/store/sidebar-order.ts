import { matchesTaskProjectFilter } from './task-project-filter';
import { store } from './core';

export interface GroupedSidebarTasks {
  grouped: Record<string, { active: string[]; collapsed: string[] }>;
  orphanedActive: string[];
  orphanedCollapsed: string[];
}

/**
 * Get ordered child task IDs for a coordinator, preserving taskOrder ordering.
 * Returns both active and collapsed children separately.
 */
export function getCoordinatorChildren(coordinatorId: string): {
  active: string[];
  collapsed: string[];
} {
  const active: string[] = [];
  const collapsed: string[] = [];
  const seen = new Set<string>();
  for (const taskId of store.taskOrder) {
    if (!seen.has(taskId) && store.tasks[taskId]?.coordinatedBy === coordinatorId) {
      seen.add(taskId);
      active.push(taskId);
    }
  }
  for (const taskId of store.collapsedTaskOrder) {
    const task = store.tasks[taskId];
    if (!seen.has(taskId) && task?.collapsed && task.coordinatedBy === coordinatorId) {
      seen.add(taskId);
      collapsed.push(taskId);
    }
  }
  return { active, collapsed };
}

/**
 * Check if a task is a child of any coordinator.
 */
export function isCoordinatedChild(taskId: string): boolean {
  const task = store.tasks[taskId];
  if (!task?.coordinatedBy) return false;
  // Only treat as child if the coordinator still exists
  return !!store.tasks[task.coordinatedBy];
}

/** Draggable sidebar rows, in the same project-grouped order the sidebar renders:
 *  active (non-child) tasks per project, then orphans. Collapsed project groups
 *  are omitted. */
export function computeSidebarDraggableTaskOrder(): string[] {
  const { grouped, orphanedActive } = computeGroupedTasks();
  const order: string[] = [];
  for (const project of store.projects) {
    if (project.tasksCollapsed) continue;
    const group = grouped[project.id];
    if (group) order.push(...group.active);
  }
  order.push(...orphanedActive);
  return order;
}

/** Group tasks by project: active first, then collapsed. Tasks without a valid project go to orphans.
 *  Coordinated children are excluded from the flat list — they render nested under their coordinator. */
export function computeGroupedTasks(): GroupedSidebarTasks {
  const grouped: Record<string, { active: string[]; collapsed: string[] }> = {};
  const orphanedActive: string[] = [];
  const orphanedCollapsed: string[] = [];
  const projectIds = new Set(store.projects.map((p) => p.id));

  for (const taskId of store.taskOrder) {
    const task = store.tasks[taskId];
    if (!task || !matchesTaskProjectFilter(taskId)) continue;
    // Skip coordinated children — they'll be rendered nested under their coordinator
    if (isCoordinatedChild(taskId)) continue;
    if (task.projectId && projectIds.has(task.projectId)) {
      (grouped[task.projectId] ??= { active: [], collapsed: [] }).active.push(taskId);
    } else {
      orphanedActive.push(taskId);
    }
  }

  for (const taskId of store.collapsedTaskOrder) {
    const task = store.tasks[taskId];
    if (!task?.collapsed || !matchesTaskProjectFilter(taskId)) continue;
    // Skip coordinated children
    if (isCoordinatedChild(taskId)) continue;
    if (task.projectId && projectIds.has(task.projectId)) {
      (grouped[task.projectId] ??= { active: [], collapsed: [] }).collapsed.push(taskId);
    } else {
      orphanedCollapsed.push(taskId);
    }
  }

  return { grouped, orphanedActive, orphanedCollapsed };
}

/** Flatten grouped tasks into the visual sidebar order: per project active then collapsed, then orphans. */
export function computeSidebarTaskOrder(): string[] {
  const { grouped, orphanedActive, orphanedCollapsed } = computeGroupedTasks();
  const order: string[] = [];
  const pushWithVisibleChildren = (taskId: string) => {
    order.push(taskId);
    const task = store.tasks[taskId];
    if (!task) return;
    const children = getCoordinatorChildren(taskId);
    order.push(...children.active, ...children.collapsed);
  };
  for (const project of store.projects) {
    if (project.tasksCollapsed) continue;
    const group = grouped[project.id];
    if (group) {
      for (const taskId of group.active) pushWithVisibleChildren(taskId);
      for (const taskId of group.collapsed) pushWithVisibleChildren(taskId);
    }
  }
  for (const taskId of orphanedActive) pushWithVisibleChildren(taskId);
  for (const taskId of orphanedCollapsed) pushWithVisibleChildren(taskId);
  return order;
}

/** Visual grouping key: a task's project id, `__orphan__` for a task whose
 *  project no longer exists, or null for anything that is not a task (terminals). */
export function taskVisualGroupKey(taskId: string): string | null {
  const task = store.tasks[taskId];
  if (!task) return null;
  const projectId = task.projectId;
  return projectId && store.projects.some((project) => project.id === projectId)
    ? projectId
    : '__orphan__';
}

/** Stable sort of any id list into the tile grouping: projects in
 *  `store.projects` order, then orphaned tasks, then terminals and other ids,
 *  with coordinated children right after their coordinator.
 *  For lists the tile order does not cover, such as all projects in the quick
 *  switcher or minimized tasks on the board. */
export function sortByProjectGroup(ids: readonly string[]): string[] {
  const projectRank = new Map(store.projects.map((project, index) => [project.id, index]));
  const rank = (id: string): number => {
    const group = taskVisualGroupKey(id);
    if (group === null) return projectRank.size + 1;
    return projectRank.get(group) ?? projectRank.size;
  };
  return nestCoordinatedChildren([...ids].sort((a, b) => rank(a) - rank(b)));
}

/** Order a project's active tasks so each coordinator's children follow it,
 *  keeping their taskOrder order. A child whose coordinator is not in the list
 *  stays as a standalone entry. */
function nestCoordinatedChildren(ids: readonly string[]): string[] {
  const present = new Set(ids);
  const childrenByParent = new Map<string, string[]>();
  const topLevel: string[] = [];
  for (const id of ids) {
    const parentId = store.tasks[id]?.coordinatedBy;
    if (parentId && parentId !== id && present.has(parentId)) {
      const siblings = childrenByParent.get(parentId);
      if (siblings) siblings.push(id);
      else childrenByParent.set(parentId, [id]);
    } else {
      topLevel.push(id);
    }
  }
  const order: string[] = [];
  for (const id of topLevel) {
    order.push(id);
    const children = childrenByParent.get(id);
    if (children) order.push(...children);
  }
  return order;
}

/** Active task tiles in visual order: projects in `store.projects` order, each
 *  project's tasks in taskOrder order with coordinated children following their
 *  coordinator, then orphaned tasks. Collapsed tasks are not tiles and are
 *  excluded; collapsed project groups still show, matching the tile strip. */
export function computeVisibleTaskOrder(): string[] {
  const projectIds = new Set(store.projects.map((project) => project.id));
  const byProject = new Map<string, string[]>();
  const orphans: string[] = [];
  for (const taskId of store.taskOrder) {
    const task = store.tasks[taskId];
    if (!task || !matchesTaskProjectFilter(taskId)) continue;
    if (task.projectId && projectIds.has(task.projectId)) {
      const group = byProject.get(task.projectId);
      if (group) group.push(taskId);
      else byProject.set(task.projectId, [taskId]);
    } else {
      orphans.push(taskId);
    }
  }
  const order: string[] = [];
  for (const project of store.projects) {
    const group = byProject.get(project.id);
    if (group) order.push(...nestCoordinatedChildren(group));
  }
  order.push(...nestCoordinatedChildren(orphans));
  return order;
}

/** Tile order across the main strip: grouped task tiles first, then terminal
 *  tiles (which belong to no project) in their existing order. */
export function computeTileOrder(): string[] {
  const tasks = computeVisibleTaskOrder();
  const terminals: string[] = [];
  for (const taskId of store.taskOrder) {
    if (store.terminals?.[taskId] && matchesTaskProjectFilter(taskId)) terminals.push(taskId);
  }
  return [...tasks, ...terminals];
}

/** Tiles that move as one: the task's coordinator (or the task itself) and its
 *  active children. */
export function reorderBlock(taskId: string): string[] {
  const parentId = store.tasks[taskId]?.coordinatedBy;
  const owner = parentId && store.tasks[parentId] ? parentId : taskId;
  return [owner, ...getCoordinatorChildren(owner).active];
}

/** New taskOrder after moving `movedId`'s block (a coordinator plus its active
 *  children) to `targetIndex` in the visual `order`. Returns null when the drop
 *  falls outside the block's project group, so cross-group drags do nothing. */
export function computeVisualReorder(
  order: readonly string[],
  movedId: string,
  targetIndex: number,
): string[] | null {
  const block = reorderBlock(movedId);
  const owner = block[0];
  const removed = new Set(block);
  // Callers count the target with only the moved tile removed; the rest of its
  // block may still sit on either side of it.
  const withoutMoved = order.filter((id) => id !== movedId);
  const clamped = Math.max(0, Math.min(targetIndex, withoutMoved.length));
  const nextId = withoutMoved.slice(clamped).find((id) => !removed.has(id)) ?? null;
  // A child renders right after its coordinator, so a drop before the child
  // goes before the whole block; otherwise the tile would snap back.
  const insertBeforeId = nextId ? (reorderBlock(nextId)[0] ?? nextId) : null;
  const previousId =
    withoutMoved
      .slice(0, clamped)
      .reverse()
      .find((id) => !removed.has(id)) ?? null;
  const group = taskVisualGroupKey(owner);
  const rawRemaining = store.taskOrder.filter((id) => !removed.has(id));

  let rawInsertAt: number;
  if (insertBeforeId && taskVisualGroupKey(insertBeforeId) === group) {
    rawInsertAt = rawRemaining.indexOf(insertBeforeId);
  } else if (previousId && taskVisualGroupKey(previousId) === group) {
    rawInsertAt = rawRemaining.indexOf(previousId) + 1;
  } else {
    return null;
  }
  if (rawInsertAt < 0) return null;
  return [...rawRemaining.slice(0, rawInsertAt), ...block, ...rawRemaining.slice(rawInsertAt)];
}
