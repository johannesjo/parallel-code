import { store, setStore } from './core';

const TASK_CLICKABLE_PREVIEW_PX = 64;

// Imperative focus registry: components register focus callbacks on mount.
const focusRegistry = new Map<string, () => void>();

export function registerFocusFn(key: string, fn: () => void): void {
  focusRegistry.set(key, fn);
}

export function unregisterFocusFn(key: string): void {
  focusRegistry.delete(key);
}

export function triggerFocus(key: string): void {
  focusRegistry.get(key)?.();
}

export const AI_TERMINAL_PANEL = 'ai-terminal';

export function aiTerminalPanelId(agentId: string): string {
  return `${AI_TERMINAL_PANEL}:${agentId}`;
}

export function isAiTerminalPanel(panel: string): boolean {
  return panel === AI_TERMINAL_PANEL || panel.startsWith(`${AI_TERMINAL_PANEL}:`);
}

function agentIdFromAiTerminalPanel(panel: string): string | null {
  return panel.startsWith(`${AI_TERMINAL_PANEL}:`)
    ? panel.slice(AI_TERMINAL_PANEL.length + 1)
    : null;
}

export function aiTerminalPanels(task: { agentIds: string[] }): string[] {
  return task.agentIds.length > 0 ? task.agentIds.map(aiTerminalPanelId) : [AI_TERMINAL_PANEL];
}

function normalizeTaskPanel(taskId: string, panel: string): string {
  if (panel !== AI_TERMINAL_PANEL) return panel;
  const task = store.tasks[taskId];
  if (!task) return panel;
  const activeAgentId = store.activeAgentId;
  const agentId =
    activeAgentId && task.agentIds.includes(activeAgentId) ? activeAgentId : task.agentIds[0];
  return agentId ? aiTerminalPanelId(agentId) : panel;
}

export function defaultPanelFor(panelId: string): string {
  const task = store.tasks[panelId];
  return task ? aiTerminalPanels(task)[0] : 'terminal';
}

export function getTaskFocusedPanel(taskId: string): string {
  return normalizeTaskPanel(taskId, store.focusedPanel[taskId] ?? defaultPanelFor(taskId));
}

/**
 * Whether a panel within a task should render its focus border. Returns false
 * when focus has moved to the sidebar/placeholder, even though the previously
 * focused panel is still recorded in `focusedPanel[taskId]`.
 */
export function isPanelFocused(taskId: string, panel: string): boolean {
  if (store.sidebarFocused || store.placeholderFocused) return false;
  if (store.activeTaskId !== taskId) return false;
  return store.focusedPanel[taskId] === panel;
}

export function isPanelFocusedPrefix(taskId: string, prefix: string): boolean {
  if (store.sidebarFocused || store.placeholderFocused) return false;
  if (store.activeTaskId !== taskId) return false;
  return store.focusedPanel[taskId]?.startsWith(prefix) ?? false;
}

export function setTaskFocusedPanel(taskId: string, panel: string): void {
  const normalizedPanel = normalizeTaskPanel(taskId, panel);
  setStore('focusedPanel', taskId, normalizedPanel);
  const agentId = agentIdFromAiTerminalPanel(normalizedPanel);
  if (agentId && store.tasks[taskId]?.agentIds.includes(agentId)) {
    setStore('activeAgentId', agentId);
    setStore('tasks', taskId, 'selectedAgentId', agentId);
  }
  setStore('sidebarFocused', false);
  setStore('placeholderFocused', false);
  triggerFocus(`${taskId}:${normalizedPanel}`);
  scrollTaskIntoView(taskId);
}

function findHorizontalScroller(el: HTMLElement): HTMLElement | null {
  // Use a marker so we never pick nested panel scrollers (e.g. sub-task strips).
  return el.closest<HTMLElement>('[data-tiling-strip]');
}

function computeTaskStripScrollLeft(
  scroller: HTMLElement,
  taskId: string,
  el: HTMLElement,
): number | null {
  // First/last tasks snap to the strip edges so overflow affordances disappear.
  const activeIndex = store.taskOrder.indexOf(taskId);
  if (activeIndex === -1) return null;
  if (activeIndex === 0) return 0;
  if (activeIndex === store.taskOrder.length - 1) {
    return scroller.scrollWidth - scroller.clientWidth;
  }

  // Measure the scroller and the active task relative to the viewport so we can
  // tell whether the task is fully visible, including the clickable preview
  // margins on each side.
  const scrollerRect = scroller.getBoundingClientRect();
  const itemRect = el.getBoundingClientRect();
  const { scrollLeft, scrollWidth, clientWidth } = scroller;
  const scrollerLeft = scrollerRect.left;
  const scrollerRight = scrollerRect.right;
  const itemLeft = itemRect.left;
  const itemRight = itemRect.right;
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);

  // Positive when the task overflows the corresponding scroller edge.
  const leftPreviewShortage = Math.max(0, scrollerLeft + TASK_CLICKABLE_PREVIEW_PX - itemLeft);
  const rightPreviewShortage = Math.max(0, itemRight - (scrollerRight - TASK_CLICKABLE_PREVIEW_PX));

  // Already fully visible with both preview margins intact: nothing to do.
  if (leftPreviewShortage === 0 && rightPreviewShortage === 0) return null;

  let target: number;
  if (
    leftPreviewShortage > 0 &&
    (rightPreviewShortage === 0 ||
      Math.abs(itemLeft - scrollerLeft) <= Math.abs(scrollerRight - itemRight))
  ) {
    target = scrollLeft + (itemLeft - scrollerLeft) - TASK_CLICKABLE_PREVIEW_PX;
  } else {
    target = scrollLeft + (itemRight - scrollerRight) + TASK_CLICKABLE_PREVIEW_PX;
  }

  return Math.min(maxScrollLeft, Math.max(0, target));
}

export function scrollTaskElementIntoView(
  scroller: HTMLElement | null,
  taskId: string,
  el: HTMLElement,
  behavior: ScrollBehavior = 'instant',
): void {
  if (!scroller) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior });
    return;
  }

  const target = computeTaskStripScrollLeft(scroller, taskId, el);
  if (target !== null) scroller.scrollTo({ left: target, behavior });
}

export function createInitialTaskScrollBehavior(): () => ScrollBehavior {
  let initialScrollPending = true;
  return () => {
    if (!initialScrollPending) return 'smooth';
    initialScrollPending = false;
    return 'instant';
  };
}

function scrollTaskIntoView(taskId: string): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
    if (!el) return;
    scrollTaskElementIntoView(findHorizontalScroller(el), taskId, el, 'smooth');
  });
}
