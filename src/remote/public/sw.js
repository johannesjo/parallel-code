/* global self, URL, URLSearchParams */

// Delivery only: task data and authenticated responses are never cached here.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    // Even a malformed push must display a notification (userVisibleOnly).
  }
  const taskId = typeof payload?.taskId === 'string' ? payload.taskId : '';
  const taskName = typeof payload?.taskName === 'string' ? payload.taskName.slice(0, 200) : '';
  event.waitUntil(
    self.registration.showNotification(taskName || 'Parallel Code', {
      body: 'A task needs your input.',
      icon: '/icons/icon-192.png',
      tag: taskId ? `needs-input:${taskId}` : 'needs-input',
      renotify: true,
      data: { taskId },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const taskId = event.notification.data?.taskId;
  // Construct the destination ourselves; push content can never supply an external URL or token.
  const url = new URL('/', self.location.origin);
  if (typeof taskId === 'string' && taskId)
    url.hash = new URLSearchParams({ task: taskId }).toString();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== url.origin) continue;
        const navigated = await client.navigate(url.href);
        if (navigated) return navigated.focus();
      }
      return self.clients.openWindow(url.href);
    })(),
  );
});
