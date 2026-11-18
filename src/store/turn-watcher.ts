import { createEffect, createRoot, untrack } from 'solid-js';
import { CONFIDENCE_CARD_ID } from '../../electron/shared/card-publish';
import type { CardDefinition } from '../lib/cards';
import { refreshBranchFacts } from './app-facts';
import { runAfterTurnCheckCards } from './card-checks';
import { runAfterTurnCards } from './card-models';
import { enabledCards } from './cards';
import { store } from './core';
import { refreshCodeFingerprint } from './task-diff';
import { isTaskWorking } from './taskStatus';

/** A turn has to stay finished this long before it is read. */
const TURN_SETTLE_MS = 4_000;
/** Terminal heuristics can flicker between busy and idle; never run more often than this. */
const MIN_RUN_INTERVAL_MS = 45_000;
// Gap between first reads of idle tasks tracked at once (launch, or a card
// switched on), so a dozen tasks don't start their git reads together.
const FIRST_READ_STAGGER_MS = 1_000;

/**
 * Whether a card needs the diff read after a turn. Confidence alone does not:
 * with no rating there is nothing to date. Activity and CI come from live state.
 */
function readsDiff(card: CardDefinition): boolean {
  if (card.builtIn) return false;
  return card.source.kind !== 'app' || !['activity', 'ci'].includes(card.source.fact);
}

/**
 * Whether the tracker reads the task's diff after a turn: while a card that
 * needs it is on for its project, or while a rating could go out of date.
 */
function isTracked(taskId: string): boolean {
  const task = store.tasks[taskId];
  if (!task) return false;
  return !!task.cards?.[CONFIDENCE_CARD_ID] || enabledCards(task.projectId).some(readsDiff);
}

/**
 * Runs the fingerprint tracker whenever a task's agents go from working to
 * finished and stay there for a moment, while the task is tracked. Each run is
 * one local `git diff` and no model call.
 * Returns the stop function.
 */
export function startTurnWatcher(): () => void {
  return createRoot((dispose) => {
    const working = new Map<string, boolean>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const lastRun = new Map<string, number>();

    function clearTimer(taskId: string): void {
      const timer = timers.get(taskId);
      if (timer !== undefined) clearTimeout(timer);
      timers.delete(taskId);
    }

    /** `turnEnded` is false for the first read of a task that was idle: no model call then. */
    function schedule(taskId: string, turnEnded: boolean, extraDelay = 0): void {
      clearTimer(taskId);
      const sinceLast = Date.now() - (lastRun.get(taskId) ?? 0);
      const delay = Math.max(TURN_SETTLE_MS, MIN_RUN_INTERVAL_MS - sinceLast) + extraDelay;
      timers.set(
        taskId,
        setTimeout(() => {
          timers.delete(taskId);
          if (isTaskWorking(taskId)) return;
          lastRun.set(taskId, Date.now());
          void refreshCodeFingerprint(taskId).then((rawDiff) => {
            if (!turnEnded) return;
            runAfterTurnCards(taskId, rawDiff);
            void runAfterTurnCheckCards(taskId, rawDiff);
          });
          void refreshBranchFacts(taskId);
        }, delay),
      );
    }

    function forget(taskId: string): void {
      working.delete(taskId);
      clearTimer(taskId);
    }

    createEffect(() => {
      const ids = new Set(store.taskOrder);
      let firstReads = 0;
      for (const taskId of ids) {
        // Forget it, so turning a card on later counts as newly tracked.
        if (!isTracked(taskId)) {
          untrack(() => forget(taskId));
          continue;
        }
        const now = isTaskWorking(taskId);
        const seen = untrack(() => working.has(taskId));
        const was = untrack(() => working.get(taskId)) ?? false;
        working.set(taskId, now);
        // A task newly tracked while idle is read once, so its cards need not wait for a turn.
        if (now) clearTimer(taskId);
        else if (was) schedule(taskId, true);
        else if (!seen) schedule(taskId, false, firstReads++ * FIRST_READ_STAGGER_MS);
      }
      for (const taskId of [...working.keys(), ...timers.keys()]) {
        if (ids.has(taskId)) continue;
        forget(taskId);
        lastRun.delete(taskId);
      }
    });

    return () => {
      for (const taskId of [...timers.keys()]) clearTimer(taskId);
      dispose();
    };
  });
}
