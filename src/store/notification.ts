import { createSignal } from 'solid-js';
import { setStore } from './core';

/** A button on a timed notice, e.g. to open what just finished. */
export interface NotificationAction {
  /** Read reactively, so a getter can follow state that changes while the notice is up. */
  readonly label: string;
  run: () => void;
}

// Kept out of the store: the store is saved, and a function cannot be.
const [action, setAction] = createSignal<NotificationAction | null>(null);
/** The current notice's button, if it has one. */
export const notificationAction = action;

let notificationTimer: ReturnType<typeof setTimeout> | null = null;
/** Ongoing work with no known end; shown whenever no timed notice is up. */
let progressMessage: string | null = null;

export const NOTIFICATION_DEFAULT_MS = 3000;
/** Errors the user must act on stay up longer than a passing status message. */
export const NOTIFICATION_ERROR_MS = 10_000;

export function showNotification(
  message: string,
  opts?: { durationMs?: number; tone?: 'success'; action?: NotificationAction },
): void {
  if (notificationTimer) clearTimeout(notificationTimer);
  setNotice(message, false, opts?.tone ?? null);
  setAction(opts?.action ?? null);
  notificationTimer = setTimeout(() => {
    setNotice(progressMessage, progressMessage !== null);
    notificationTimer = null;
  }, opts?.durationMs ?? NOTIFICATION_DEFAULT_MS);
}

/** Sets (or with null, ends) a notice that stays up until the work it
 *  describes finishes. Timed notices show over it and then give way back. */
export function showProgressNotification(message: string | null): void {
  progressMessage = message;
  if (!notificationTimer) setNotice(message, message !== null);
}

export function clearNotification(): void {
  if (notificationTimer) clearTimeout(notificationTimer);
  notificationTimer = null;
  // A dismissed progress notice returns with its next update.
  progressMessage = null;
  setNotice(null, false);
}

/** `busy` marks ongoing work, so the notice shows a spinner. */
function setNotice(message: string | null, busy: boolean, tone: 'success' | null = null): void {
  setStore('notification', message);
  setStore('notificationBusy', busy);
  setStore('notificationTone', tone);
  // A button belongs to the notice it came with; any change of notice drops it.
  setAction(null);
}
