import { errMessage } from '../lib/log';
import { setStore, store } from './core';
import { NOTIFICATION_ERROR_MS, showNotification, showProgressNotification } from './notification';
import type { AppStore } from './types';

/** Past this, the user has moved on: the task gets notices instead of focus. */
const SLOW_CREATION_MS = 500;

interface FailedDraft {
  prefill: NonNullable<AppStore['newTaskPrefillPrompt']>;
  /** Restores a dropped link's prefill-without-sending behavior on retry. */
  dropUrl: string | null;
}

// Session-only. Failed drafts, and drafts set aside for a task, wait for the next
// New Task instead of reopening the panel, which would take focus from whatever
// the user moved on to.
const failedDrafts: FailedDraft[] = [];

/** Names of creations past SLOW_CREATION_MS, oldest first. */
const slowCreations: string[] = [];

function updateCreatingNotice(): void {
  const [first, ...rest] = slowCreations;
  showProgressNotification(
    first ? `Creating "${first}"${rest.length ? ` and ${rest.length} more` : ''}…` : null,
  );
}

export interface BackgroundTaskCreation {
  name: string;
  /** `quick` turns false once the creation counts as slow; a slow task must
   *  not take focus from whatever the user is doing by then. */
  create: (quick: () => boolean) => Promise<string>;
  /** Follow-up work for the created task. Kept apart from create so its
   *  failure cannot offer the draft again and invite a duplicate task. */
  onCreated: (taskId: string) => void;
  draft: FailedDraft;
}

/**
 * Finishes creating a task after the new-task panel has closed, so the user
 * can start the next draft while a slow worktree setup runs.
 */
export async function createTaskInBackground(job: BackgroundTaskCreation): Promise<void> {
  // shortcut: one shared notice — a sidebar placeholder if users lose track of slow creations
  let slow = false;
  const timer = setTimeout(() => {
    slow = true;
    slowCreations.push(job.name);
    updateCreatingNotice();
  }, SLOW_CREATION_MS);
  let taskId: string;
  try {
    taskId = await job.create(() => !slow);
  } catch (err) {
    // An empty draft has nothing worth offering again.
    const keep = !!(job.draft.prefill.prompt.trim() || job.draft.prefill.name?.trim());
    if (keep) failedDrafts.push(job.draft);
    // The hint goes first: git's output can run past what the toast shows.
    const reason = errMessage(err).replace(
      /^Error invoking remote method '[^']+': (?:Error: )?/,
      '',
    );
    showNotification(
      `Could not create "${job.name}"${keep ? ' (open New Task to retry)' : ''}: ${reason}`,
      { durationMs: NOTIFICATION_ERROR_MS },
    );
    return;
  } finally {
    clearTimeout(timer);
    if (slow) {
      slowCreations.splice(slowCreations.indexOf(job.name), 1);
      updateCreatingNotice();
    }
  }
  if (slow) showNotification(`"${job.name}" is ready`);
  try {
    job.onCreated(taskId);
  } catch (err) {
    showNotification(`Created "${job.name}", but setup failed: ${errMessage(err)}`, {
      durationMs: NOTIFICATION_ERROR_MS,
    });
  }
}

// Reads the open New Task panel's unsaved draft; null while no panel is mounted.
let readOpenDraft: (() => FailedDraft | null) | null = null;

/** Lets the mounted New Task panel hand over what was typed; returns the unregister. */
export function registerOpenDraft(read: () => FailedDraft | null): () => void {
  readOpenDraft = read;
  return () => {
    if (readOpenDraft === read) readOpenDraft = null;
  };
}

/** Keeps the open panel's draft for the next New Task, ahead of failed ones:
 *  it is what the user was working on last. */
export function setOpenDraftAside(): void {
  const draft = readOpenDraft?.();
  if (draft) failedDrafts.unshift(draft);
}

/** Puts the oldest failed draft into the panel about to open, unless the
 *  opener brought its own content. */
export function restoreFailedDraft(): void {
  if (store.newTaskPrefillPrompt || store.newTaskDropUrl) return;
  const draft = failedDrafts.shift();
  if (!draft) return;
  setStore({ newTaskPrefillPrompt: draft.prefill, newTaskDropUrl: draft.dropUrl });
}
