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
  for (const taskId of store.taskOrder) {
    if (store.tasks[taskId]?.coordinatedBy === coordinatorId) {
      active.push(taskId);
    }
  }
  for (const taskId of store.collapsedTaskOrder) {
    const task = store.tasks[taskId];
    if (task?.collapsed && task.coordinatedBy === coordinatorId) {
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

/** Group tasks by project: active first, then collapsed. Tasks without a valid project go to orphans.
 *  Coordinated children are excluded from the flat list — they render nested under their coordinator. */
export function computeGroupedTasks(): GroupedSidebarTasks {
  const grouped: Record<string, { active: string[]; collapsed: string[] }> = {};
  const orphanedActive: string[] = [];
  const orphanedCollapsed: string[] = [];
  const projectIds = new Set(store.projects.map((p) => p.id));

  for (const taskId of store.taskOrder) {
    const task = store.tasks[taskId];
    if (!task) continue;
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
    if (!task?.collapsed) continue;
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
  for (const project of store.projects) {
    const group = grouped[project.id];
    if (group) order.push(...group.active, ...group.collapsed);
  }
  order.push(...orphanedActive, ...orphanedCollapsed);
  return order;
}
