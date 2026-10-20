import { store, setStore } from './core';

let pendingFocus: { taskId: string; panel: string } | undefined;

/** Whether the new-task draft holds focus, so a deferred task focus/scroll must not steal it. */
function newTaskDraftHasFocus(): boolean {
  if (store.newTaskPanelFocused) return true;
  // Chromium withholds focus events while the window is unfocused (e.g. a link
  // dragged in from another app), so the flag lags DOM focus until then.
  return !!document.activeElement?.closest('[data-new-task-panel]') && !document.hasFocus();
}

/** Apply focus after batched selection changes and panel visibility effects settle. */
export function scheduleTaskFocus(taskId: string, panel: string): void {
  if (store.activeTaskId !== taskId) return;
  const alreadyPending = pendingFocus !== undefined;
  pendingFocus = { taskId, panel };
  if (alreadyPending) return;
  queueMicrotask(() => {
    const target = pendingFocus;
    pendingFocus = undefined;
    if (
      !target ||
      store.activeTaskId !== target.taskId ||
      store.sidebarFocused ||
      store.placeholderFocused ||
      newTaskDraftHasFocus()
    )
      return;
    triggerFocus(`${target.taskId}:${target.panel}`);
  });
}

// Keep in sync with `scroll-padding-inline` on `.tiling-layout-strip` in styles.css.
// This is intentionally larger than the 26px `.tiling-layout-scroll-affordance`
// width so the peeked neighbor remains clickable beyond the visual affordance.
const TASK_CLICKABLE_PREVIEW_PX = 64;

// Imperative focus registry: components register focus callbacks on mount.
const focusRegistry = new Map<string, () => void>();

export function registerFocusFn(key: string, fn: () => void): void {
  focusRegistry.set(key, fn);
}

/** Pass the registered `fn` so a component leaving a key does not delete the registration
 *  a replacement has already made under it. */
export function unregisterFocusFn(key: string, fn?: () => void): void {
  if (!fn || focusRegistry.get(key) === fn) focusRegistry.delete(key);
}

export function triggerFocus(key: string): void {
  focusRegistry.get(key)?.();
}

export const AI_TERMINAL_PANEL = 'ai-terminal';

export function aiTerminalPanelId(agentId: string): string {
  return `${AI_TERMINAL_PANEL}:${agentId}`;
}

/** Shell terminals are addressed by position in the task's `shellAgentIds`. */
const SHELL_PANEL_PREFIX = 'shell:';

export function shellPanelId(index: number): string {
  return `${SHELL_PANEL_PREFIX}${index}`;
}

export function isShellPanel(panel: string): boolean {
  return panel.startsWith(SHELL_PANEL_PREFIX);
}

export function shellPanelIndex(panel: string): number | null {
  if (!panel.startsWith(SHELL_PANEL_PREFIX)) return null;
  // Digits only — `Number('')` is 0 and `Number('1e2')` is 100, so a bare
  // `shell:` or an exponent would otherwise parse as a real panel index.
  const rest = panel.slice(SHELL_PANEL_PREFIX.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

export function isAiTerminalPanel(panel: string): boolean {
  return panel === AI_TERMINAL_PANEL || panel.startsWith(`${AI_TERMINAL_PANEL}:`);
}

export function agentIdFromAiTerminalPanel(panel: string): string | null {
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
  return taskOwnsFocus(taskId) && store.focusedPanel[taskId] === panel;
}

/** Whether focus is inside this task at all, rather than the sidebar or another task. */
function taskOwnsFocus(taskId: string): boolean {
  if (store.sidebarFocused || store.placeholderFocused || store.newTaskPanelFocused) return false;
  return store.activeTaskId === taskId;
}

/**
 * Like `isPanelFocused`, but a task whose focused panel was never recorded counts
 * as focused on its default panel. Use this where an unrecorded panel still has to
 * be able to claim the keyboard — `focusedPanel` stays unset for a freshly active
 * task whose prompt input took focus instead.
 */
export function isPanelFocusedOrDefault(taskId: string, panel: string): boolean {
  return taskOwnsFocus(taskId) && getTaskFocusedPanel(taskId) === panel;
}

/**
 * Whether a task column renders as the active one (full opacity, accent glow).
 * The new-task draft is a column of its own, so while it holds focus the still
 * active task dims like every other column instead of competing with it.
 */
export function isTaskColumnHighlighted(taskId: string | null): boolean {
  return taskId !== null && store.activeTaskId === taskId && !store.newTaskPanelFocused;
}

export function isPanelFocusedPrefix(taskId: string, prefix: string): boolean {
  if (store.sidebarFocused || store.placeholderFocused || store.newTaskPanelFocused) return false;
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
  setStore('newTaskPanelFocused', false);
  scheduleTaskFocus(taskId, normalizedPanel);
  scrollTaskIntoView(taskId);
}

function findHorizontalScroller(el: HTMLElement): HTMLElement | null {
  // Use a marker so we never pick nested panel scrollers (e.g. sub-task strips).
  return el.closest<HTMLElement>('[data-tiling-strip]');
}

function isLastTaskInScroller(scroller: HTMLElement, el: HTMLElement): boolean {
  const taskEls = scroller.querySelectorAll<HTMLElement>('[data-task-id]');
  return taskEls.length > 0 && taskEls[taskEls.length - 1] === el;
}

function maxScrollLeft(scroller: HTMLElement): number {
  return Math.max(0, scroller.scrollWidth - scroller.clientWidth);
}

export function scrollTaskElementIntoView(
  scroller: HTMLElement | null,
  el: HTMLElement,
  behavior: ScrollBehavior = 'instant',
): void {
  if (!scroller) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior });
    return;
  }

  // Very wide tasks: `inline: 'nearest'` would jump unpredictably between edges,
  // so pin the left side to the preview margin ourselves.
  const available = scroller.clientWidth - 2 * TASK_CLICKABLE_PREVIEW_PX;
  if (el.offsetWidth > available) {
    const itemOffset = el.getBoundingClientRect().left - scroller.getBoundingClientRect().left;
    const target = Math.min(
      maxScrollLeft(scroller),
      Math.max(0, scroller.scrollLeft + itemOffset - TASK_CLICKABLE_PREVIEW_PX),
    );
    scroller.scrollTo({ left: target, behavior });
    return;
  }

  // The last panel in the strip should snap flush to the right edge. Native
  // `scrollIntoView` with `scroll-padding-inline` leaves a small sliver of
  // overflow (and the right scroll affordance) visible when the trailing
  // content after the panel is narrower than the preview margin.
  if (isLastTaskInScroller(scroller, el)) {
    const limit = maxScrollLeft(scroller);
    if (scroller.scrollLeft < limit) {
      scroller.scrollTo({ left: limit, behavior });
      return;
    }
  }

  // Normal tasks: let the browser align. `scroll-padding-inline` provides the
  // preview margins and edge clamping handles first/last tasks for free.
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior });
}

let pendingScroll: { taskId: string; behavior: ScrollBehavior } | undefined;

/** Selection and pane focus share one scroll per frame, including task reorders. */
export function scrollTaskIntoView(taskId: string, behavior: ScrollBehavior = 'smooth'): void {
  if (store.activeTaskId !== taskId) return;
  const alreadyPending = pendingScroll !== undefined;
  // Keep an instant return from the draft/initial selection when pane focus
  // also requests a smooth scroll to the same task.
  if (pendingScroll?.taskId === taskId && pendingScroll.behavior === 'instant') {
    behavior = 'instant';
  }
  pendingScroll = { taskId, behavior };
  if (alreadyPending) return;
  requestAnimationFrame(() => {
    const target = pendingScroll;
    pendingScroll = undefined;
    if (
      !target ||
      (store.focusMode && !store.showNewTaskPanel) ||
      store.activeTaskId !== target.taskId ||
      store.placeholderFocused ||
      newTaskDraftHasFocus()
    )
      return;
    const el = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(target.taskId)}"]`);
    if (!el) return;
    // A canvas sits to the right of the chat. Pinning a wide task's left edge
    // would hide the very panel the user just opened or focused.
    const canvas =
      store.focusedPanel[target.taskId] === 'canvas'
        ? el.querySelector<HTMLElement>('.task-canvas-panel')
        : null;
    if (canvas) {
      canvas.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: target.behavior });
      return;
    }
    scrollTaskElementIntoView(findHorizontalScroller(el), el, target.behavior);
  });
}
