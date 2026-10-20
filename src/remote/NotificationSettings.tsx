import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { fetchPushSettings, removePushSubscription, savePushSubscription } from './api';

export function NotificationSettings() {
  const supported =
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
  const [enabled, setEnabled] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [blocked, setBlocked] = createSignal(supported && Notification.permission === 'denied');
  const [error, setError] = createSignal('');
  let registration: ServiceWorkerRegistration | undefined;
  let publicKey = '';
  let disposed = false;
  onCleanup(() => (disposed = true));

  async function prepare() {
    setError('');
    setBusy(true);
    try {
      const [settings] = await Promise.all([
        fetchPushSettings(),
        navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }),
      ]);
      registration = await navigator.serviceWorker.ready;
      publicKey = settings.publicKey;
      const subscription = await registration.pushManager.getSubscription();
      if (disposed) return;
      setEnabled(
        Notification.permission === 'granted' &&
          !!subscription &&
          subscription.endpoint === settings.endpoint,
      );
      setReady(true);
    } catch {
      if (!disposed)
        setError('Could not load notification settings. Check your connection and retry.');
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  onMount(() => {
    if (supported) void prepare();
  });

  async function toggle() {
    if (!registration || busy()) return;
    setError('');
    setBusy(true);
    try {
      if (enabled()) {
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await removePushSubscription(subscription.endpoint);
          setEnabled(false);
          await subscription.unsubscribe();
        } else setEnabled(false);
        return;
      }
      // Request permission before any other await: iOS requires a direct tap.
      const permission = await Notification.requestPermission();
      setBlocked(permission === 'denied');
      if (permission !== 'granted') return;
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
        c.charCodeAt(0),
      );
      let subscription = await registration.pushManager.getSubscription();
      const previousKey = subscription?.options.applicationServerKey;
      if (subscription && previousKey && !sameKey(new Uint8Array(previousKey), key)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      await savePushSubscription(subscription.toJSON());
      if (!disposed) setEnabled(true);
    } catch {
      if (!disposed) setError('Could not update notifications. Check your connection and retry.');
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  return (
    <details class="mobile-notifications">
      <summary>Task notifications{enabled() ? ' · On' : ''}</summary>
      <p>Get notified when a task needs input, even when your phone is locked.</p>
      <Show
        when={supported}
        fallback={
          <p>
            {window.isSecureContext
              ? 'Use a browser that supports push notifications. On iPhone, add this page to your Home Screen and open it there.'
              : 'Notifications need an HTTPS connection. Open the phone app through HTTPS, for example with Tailscale Serve.'}{' '}
            <a
              href="https://github.com/johannesjo/parallel-code#phone-notifications"
              target="_blank"
              rel="noreferrer"
            >
              Setup instructions
            </a>
          </p>
        }
      >
        <p>
          On iPhone, add this page to your Home Screen and open it there before enabling
          notifications.
        </p>
        <Show when={blocked()}>
          <p role="status">
            Notifications are blocked. Allow them in your browser or phone settings, then reopen
            this app.
          </p>
        </Show>
        <button
          class="mobile-button"
          disabled={busy() || (blocked() && !enabled())}
          onClick={() => (ready() ? void toggle() : void prepare())}
        >
          {busy()
            ? 'Please wait…'
            : !ready()
              ? 'Retry notification setup'
              : enabled()
                ? 'Turn off notifications'
                : 'Enable notifications'}
        </button>
        <p>Keep Parallel Code running on your computer with phone access enabled.</p>
      </Show>
      <Show when={error()}>
        <p class="mobile-error" role="alert">
          {error()}
        </p>
      </Show>
    </details>
  );
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
