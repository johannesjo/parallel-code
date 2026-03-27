import { store } from './core';

export interface GroupedSidebarTasks {
  grouped: Record<string, { active: string[] }>;
  orphanedActive: string[];
}

/** Group tasks by project. Tasks without a valid project go to orphans. */
export function computeGroupedTasks(): GroupedSidebarTasks {
  const grouped: Record<string, { active: string[] }> = {};
  const orphanedActive: string[] = [];
  const projectIds = new Set(store.projects.map((p) => p.id));

  for (const taskId of store.taskOrder) {
    const task = store.tasks[taskId];
    if (!task) continue;
    if (task.projectId && projectIds.has(task.projectId)) {
      (grouped[task.projectId] ??= { active: [] }).active.push(taskId);
    } else {
      orphanedActive.push(taskId);
    }
  }

  return { grouped, orphanedActive };
}

/** Flatten grouped tasks into the visual sidebar order: per project active, then orphans. */
export function computeSidebarTaskOrder(): string[] {
  const { grouped, orphanedActive } = computeGroupedTasks();
  const order: string[] = [];
  for (const project of store.projects) {
    const group = grouped[project.id];
    if (group) order.push(...group.active);
  }
  order.push(...orphanedActive);
  return order;
}
