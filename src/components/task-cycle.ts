import { createSignal } from 'solid-js';
import { store } from '../store/core';
import {
  attentionTargets,
  openCycledItem,
  openNextAttentionTask,
  openPreviousTask,
} from './next-attention-task';
import { switcherItems } from './TaskSwitcher';

/**
 * How long the modifier must stay down after Tab before the list shows. A
 * quicker tap never shows it and lands where it always did. A hold threshold,
 * not an animation: the list appears at once when it passes.
 */
export const CYCLE_REVEAL_MS = 250;

export interface TaskCycle {
  /** Snapshot taken on the first press, so rows do not reorder under the keys. */
  ids: string[];
  /** -1 when nothing is selected yet. */
  index: number;
  visible: boolean;
}

const [cycle, setCycle] = createSignal<TaskCycle | null>(null);
/** The held Ctrl+Tab list, or null while it is not in use. */
export { cycle };

let revealTimer: ReturnType<typeof setTimeout> | undefined;
let listeners: AbortController | undefined;

type HeldKeys = Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey'>;
// Shift only flips direction; releasing the anchoring modifier is the commit.
const anchorHeld = (e: HeldKeys): boolean => e.ctrlKey || e.metaKey || e.altKey;

/** Waiting tasks first, in the order taps visit them, then every other open item. */
function cycleIds(waiting: string[]): string[] {
  const rest = switcherItems()
    .map((item) => item.id)
    .filter((id) => !waiting.includes(id));
  return [...waiting, ...rest];
}

function end(): TaskCycle | null {
  const current = cycle();
  clearTimeout(revealTimer);
  revealTimer = undefined;
  listeners?.abort();
  listeners = undefined;
  setCycle(null);
  return current;
}

/** Leaves the list without switching. */
export function cancelCycle(): void {
  end();
}

/** Switches to the selected item and closes the list. */
export function commitCycle(): void {
  const done = end();
  const id = done?.ids[done.index];
  if (id && id !== store.activeTaskId) openCycledItem(id);
}

/** Selects a row (pointer hover) and shows the list if it is still hidden. */
export function selectCycled(index: number): void {
  clearTimeout(revealTimer);
  setCycle((c) => c && { ...c, index, visible: true });
}

function step(delta: 1 | -1): void {
  const c = cycle();
  if (!c) return;
  const count = c.ids.length;
  const from = c.index < 0 ? (delta > 0 ? -1 : 0) : c.index;
  selectCycled((from + delta + count) % count);
}

function onKeyDown(e: KeyboardEvent): void {
  // A missed keyup (focus was elsewhere) still ends the hold on the next key.
  if (!anchorHeld(e)) return commitCycle();
  const action = {
    Escape: cancelCycle,
    Enter: commitCycle,
    ArrowDown: () => step(1),
    ArrowUp: () => step(-1),
  }[e.key];
  if (!action) return;
  // Captured before the terminal or a focused input sees it.
  e.preventDefault();
  e.stopPropagation();
  action();
}

function listen(): void {
  listeners = new AbortController();
  const opts = { capture: true, signal: listeners.signal };
  window.addEventListener('keydown', onKeyDown, opts);
  window.addEventListener(
    'keyup',
    (e) => {
      if (!anchorHeld(e)) commitCycle();
    },
    opts,
  );
  // Not captured: a capture listener would also see every element losing
  // focus, such as the terminal when a row is clicked.
  window.addEventListener('blur', cancelCycle, { signal: listeners.signal });
}

/**
 * Ctrl+Tab. A tap opens the next task that needs you, on release; holding the
 * modifier shows every open item, Tab moves on, and releasing switches.
 */
export function cycleForward(e: HeldKeys): void {
  if (cycle()) return step(1);
  // No modifier to release (a palette pick, a rebinding to a plain key).
  if (!anchorHeld(e)) return openNextAttentionTask();
  const { ids: waiting, next } = attentionTargets();
  const ids = cycleIds(waiting);
  if (ids.length === 0) return;
  const index = ids.indexOf(next ?? store.activeTaskId ?? '');
  setCycle({ ids, index, visible: false });
  revealTimer = setTimeout(() => setCycle((c) => c && { ...c, visible: true }), CYCLE_REVEAL_MS);
  listen();
}

/** Ctrl+Shift+Tab: back one row while the list is held, otherwise the previous task. */
export function cycleBack(): void {
  if (cycle()) step(-1);
  else openPreviousTask();
}
