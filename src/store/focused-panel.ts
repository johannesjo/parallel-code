import { store, setStore } from './core';

// Keep in sync with `scroll-padding-inline` on `.tiling-layout-strip` in styles.css.
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

export function scrollTaskElementIntoView(
  scroller: HTMLElement | null,
  el: HTMLElement,
  behavior: ScrollBehavior = 'instant',
): void {
  // Very wide tasks: `inline: 'nearest'` would jump unpredictably between edges,
  // so pin the left side to the preview margin ourselves.
  if (scroller) {
    const available = scroller.clientWidth - 2 * TASK_CLICKABLE_PREVIEW_PX;
    if (el.offsetWidth > available) {
      const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const itemOffset = el.getBoundingClientRect().left - scroller.getBoundingClientRect().left;
      const target = Math.min(
        maxScrollLeft,
        Math.max(0, scroller.scrollLeft + itemOffset - TASK_CLICKABLE_PREVIEW_PX),
      );
      scroller.scrollTo({ left: target, behavior });
      return;
    }
  }

  // Normal tasks: let the browser align. `scroll-padding-inline` provides the
  // preview margins and edge clamping handles first/last tasks for free.
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior });
}

function scrollTaskIntoView(taskId: string): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
    if (!el) return;
    scrollTaskElementIntoView(findHorizontalScroller(el), el, 'smooth');
  });
}
