import { setStore } from './core';

let notificationTimer: ReturnType<typeof setTimeout> | null = null;

export const NOTIFICATION_DEFAULT_MS = 3000;
/** Errors the user must act on stay up longer than a passing status message. */
export const NOTIFICATION_ERROR_MS = 10_000;

export function showNotification(message: string, opts?: { durationMs?: number }): void {
  if (notificationTimer) clearTimeout(notificationTimer);
  setStore('notification', message);
  notificationTimer = setTimeout(() => {
    setStore('notification', null);
    notificationTimer = null;
  }, opts?.durationMs ?? NOTIFICATION_DEFAULT_MS);
}

export function clearNotification(): void {
  if (notificationTimer) clearTimeout(notificationTimer);
  notificationTimer = null;
  setStore('notification', null);
}
