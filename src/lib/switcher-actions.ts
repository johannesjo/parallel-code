import { formatKeyCombo } from './keybindings/format';
import type { KeyBinding } from './keybindings/types';
import { errMessage, warn as logWarn } from './log';
import type { SwitcherItem } from './task-switcher';

/** What the switcher needs to know to list only actions that would do something now. */
export interface ActionContext {
  /** Name of the active task, terminal or document workspace; null when none is. */
  activeName: string | null;
  /** The active item is a real task with a worktree, not a terminal or hidden agent. */
  taskActive: boolean;
  documentOpen: boolean;
}

/** Which active item an action needs; it is hidden without one. A prompt is
 *  on a real task or in a document workspace, never in a plain terminal. */
type Scope = 'item' | 'task' | 'prompt' | 'document';

interface ActionInfo {
  keywords?: string;
  scope?: Scope;
}

// Words people search for that the descriptions don't contain. The scopes
// mirror the guards in App.tsx's handlers, which do nothing without them.
export const ACTION_INFO: Record<string, ActionInfo> = {
  newTask: { keywords: 'create add start agent worktree' },
  addIdea: { keywords: 'later backlog todo note' },
  createTerminal: { keywords: 'shell console' },
  spawnShell: { keywords: 'terminal console', scope: 'task' },
  finishTask: { keywords: 'merge push done complete land', scope: 'task' },
  createPullRequest: { keywords: 'pr github open draft', scope: 'task' },
  closeTask: { keywords: 'delete remove discard', scope: 'item' },
  secondOpinion: { keywords: 'review compare another agent', scope: 'task' },
  sendPrompt: { keywords: 'submit run', scope: 'prompt' },
  switchDocument: { keywords: 'file open', scope: 'document' },
  toggleSidebar: { keywords: 'hide show' },
  toggleFocusMode: { keywords: 'zen maximize tiles layout' },
  toggleBoardView: { keywords: 'kanban overview' },
  openNextAttentionTask: { keywords: 'attention waiting blocked question' },
  openPreviousAttentionTask: { keywords: 'attention waiting blocked question' },
  toggleHelp: { keywords: 'shortcuts keyboard keys' },
  toggleSettings: { keywords: 'preferences options config' },
  newThinkingTour: { keywords: 'thinking space explain' },
  zoomIn: { keywords: 'bigger larger font size' },
  zoomOut: { keywords: 'smaller font size' },
  resetZoom: { keywords: 'font size default' },
  redrawTerminals: { keywords: 'refresh repaint glitch' },
};

/**
 * Shortcut actions the switcher can run now, one per action, in shortcut-list
 * order. Unbound ones stay listed: running an action without a key is the
 * point of a command palette. The shortcut shows beside the name to teach it,
 * and an action on the active item names that item, so it is clear what
 * Enter will close or finish.
 */
export function switcherActions(bindings: KeyBinding[], context: ActionContext): SwitcherItem[] {
  const byAction = new Map<string, SwitcherItem>();
  for (const binding of bindings) {
    const action = binding.action;
    if (binding.layer !== 'app' || !action || !paletteWorthy(action)) continue;
    const info = ACTION_INFO[action] ?? {};
    if (!inScope(info.scope, context)) continue;
    const shortcut = binding.unbound ? '' : formatKeyCombo(binding);
    const existing = byAction.get(action);
    // The first binding names the action; a later one only fills in a missing key.
    if (existing) {
      existing.shortcut ||= shortcut;
      continue;
    }
    const detail = info.scope && info.scope !== 'document' ? (context.activeName ?? '') : '';
    byAction.set(action, {
      id: action,
      name: binding.description,
      detail,
      shortcut,
      keywords: info.keywords,
    });
  }
  return [...byAction.values()];
}

// Escape has no meaning once the switcher has closed, opening the switcher
// from itself does nothing, and the open tasks already stand in for jump-to-N.
// Moving focus or a task, or closing the focused panel, acts relative to
// where the keyboard is, and picking from a list is no place to aim from.
const LEFT_OUT = new Set(['closeDialogs', 'openTaskSwitcher', 'closeShell']);
const LEFT_OUT_PREFIXES = ['jumpToTask:', 'navigate', 'moveActiveTask:'];

function paletteWorthy(action: string): boolean {
  return !LEFT_OUT.has(action) && !LEFT_OUT_PREFIXES.some((prefix) => action.startsWith(prefix));
}

function inScope(scope: Scope | undefined, context: ActionContext): boolean {
  if (scope === 'item') return context.activeName !== null;
  if (scope === 'task') return context.taskActive;
  if (scope === 'prompt') return context.taskActive || context.documentOpen;
  if (scope === 'document') return context.documentOpen;
  return true;
}

const RECENT_KEY = 'task-switcher:recent-actions';
const RECENT_LIMIT = 5;

/** Most recently run actions first, as VS Code and Raycast list them. */
export function loadRecentActions(): string[] {
  const raw = localStorage.getItem(RECENT_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch (err) {
    // Only an ordering hint: start over rather than fail the switcher.
    logWarn('task-switcher', 'Ignoring unreadable recent actions', { error: errMessage(err) });
    return [];
  }
}

/** Puts an action at the front of the recent list, saves it and returns it. */
export function rememberAction(id: string, recent: string[]): string[] {
  const next = [id, ...recent.filter((other) => other !== id)].slice(0, RECENT_LIMIT);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  return next;
}

/** Recent actions first in recency order; the rest keep their order. */
export function orderByRecency(actions: SwitcherItem[], recent: string[]): SwitcherItem[] {
  const position = (item: SwitcherItem) => {
    const index = recent.indexOf(item.id);
    return index === -1 ? recent.length : index;
  };
  return [...actions].sort((a, b) => position(a) - position(b));
}
