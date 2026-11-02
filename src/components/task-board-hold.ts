import { createSignal } from 'solid-js';
import type { CardTaskState } from './board/task-state';

/** How long a card stays in Working after its agent goes quiet. */
export const WORKING_HOLD_MS = 2_000;

// Not reactive: written while states are read. `expired` re-runs the readers
// once a hold runs out.
const working = new Set<string>();
const holds = new Map<string, ReturnType<typeof setTimeout>>();
const [expired, setExpired] = createSignal(0);

function startHold(taskId: string): void {
  holds.set(
    taskId,
    setTimeout(() => {
      holds.delete(taskId);
      working.delete(taskId);
      setExpired((n) => n + 1);
    }, WORKING_HOLD_MS),
  );
}

/**
 * Keeps a task that just stopped working in the Working lane for a moment, so
 * short pauses between agent steps don't bounce its card to Stopped and back.
 * Urgent states (a question, a failure, a review) pass through at once.
 */
export function holdWorking(taskId: string, state: CardTaskState): CardTaskState {
  expired(); // reactive read: re-evaluate when a hold runs out
  if (state === 'active') {
    clearTimeout(holds.get(taskId));
    holds.delete(taskId);
    working.add(taskId);
    return state;
  }
  if (!working.has(taskId)) return state;
  if (state !== 'ready' && state !== 'idle') {
    clearTimeout(holds.get(taskId));
    holds.delete(taskId);
    working.delete(taskId);
    return state;
  }
  if (!holds.has(taskId)) startHold(taskId);
  return 'active';
}

/**
 * Drops every hold. The board only sees transitions while it is mounted, so it
 * calls this on close; otherwise work that stopped meanwhile would reopen in
 * Working.
 */
export function forgetWorkingHolds(): void {
  for (const timer of holds.values()) clearTimeout(timer);
  holds.clear();
  working.clear();
}
