import { createEffect, createRoot, createSignal } from 'solid-js';
import { store } from './core';
import { getTaskAttentionState, type TaskAttentionState } from './taskStatus';
import {
  shouldShowDesktopNotificationForTask,
  type NotificationType,
} from './desktopNotifications';
import { playCompletionChime } from '../lib/completion-chime';

/** A one-shot visual pulse on a task column; `at` changes so repeats retrigger. */
export interface TaskGlow {
  type: NotificationType;
  at: number;
}

const [glows, setGlows] = createSignal<ReadonlyMap<string, TaskGlow>>(new Map());
let activeWatcherCleanup: (() => void) | undefined;

/** Which cue (if any) a task attention transition deserves. */
export function cueTypeFor(
  previous: TaskAttentionState | undefined,
  current: TaskAttentionState,
): NotificationType | null {
  // Initial population is not a transition the user caused.
  if (previous === undefined || previous === current) return null;
  if (current === 'ready' || current === 'needs_input' || current === 'error') return current;
  return null;
}

/** When several tasks flip at once, one chime plays: the most urgent wins. */
export function mostUrgentCue(cues: readonly NotificationType[]): NotificationType | null {
  if (cues.includes('error')) return 'error';
  if (cues.includes('needs_input')) return 'needs_input';
  if (cues.includes('ready')) return 'ready';
  return null;
}

export function taskGlow(taskId: string): TaskGlow | undefined {
  return glows().get(taskId);
}

export function pulseTaskGlow(taskId: string, type: NotificationType, at = Date.now()): void {
  setGlows((prev) => new Map(prev).set(taskId, { type, at }));
}

export function clearTaskGlow(taskId: string): void {
  setGlows((prev) => {
    if (!prev.has(taskId)) return prev;
    const next = new Map(prev);
    next.delete(taskId);
    return next;
  });
}

function collectCues(previous: Map<string, TaskAttentionState>): NotificationType[] {
  const cues: NotificationType[] = [];
  const seen = new Set<string>();
  for (const taskId of [...store.taskOrder, ...store.collapsedTaskOrder]) {
    seen.add(taskId);
    const current = getTaskAttentionState(taskId);
    const cue = cueTypeFor(previous.get(taskId), current);
    previous.set(taskId, current);
    if (!cue) continue;
    if (!shouldShowDesktopNotificationForTask(cue, taskId, store.tasks, store.agents)) continue;
    pulseTaskGlow(taskId, cue);
    cues.push(cue);
  }
  for (const taskId of previous.keys()) {
    if (seen.has(taskId)) continue;
    previous.delete(taskId);
    clearTaskGlow(taskId);
  }
  return cues;
}

/**
 * In-app counterpart of the desktop notification watcher: when a task turns
 * ready, blocks on a question, or errors, its column glows and (optionally) a
 * chime plays. Runs whether or not the window is focused — that is the point.
 * Owns its own reactive root so the returned cleanup really stops the effect.
 */
export function startAttentionCueWatcher(): () => void {
  activeWatcherCleanup?.();
  const previous = new Map<string, TaskAttentionState>();

  const dispose = createRoot((disposeRoot) => {
    createEffect(() => {
      const chime = mostUrgentCue(collectCues(previous));
      if (chime && store.completionSoundEnabled) playCompletionChime(chime);
    });
    return disposeRoot;
  });

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    dispose();
    if (activeWatcherCleanup === cleanup) activeWatcherCleanup = undefined;
  };
  activeWatcherCleanup = cleanup;
  return cleanup;
}
