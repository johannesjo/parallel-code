import { setStore } from "./core";

let notificationTimer: ReturnType<typeof setTimeout> | null = null;

export function showNotification(message: string): void {
  if (notificationTimer) clearTimeout(notificationTimer);
  setStore("notification", message);
  notificationTimer = setTimeout(() => {
    setStore("notification", null);
    notificationTimer = null;
  }, 3000);
}

export function clearNotification(): void {
  if (notificationTimer) clearTimeout(notificationTimer);
  notificationTimer = null;
  setStore("notification", null);
}
