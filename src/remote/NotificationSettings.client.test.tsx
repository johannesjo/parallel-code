import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { NotificationSettings } from './NotificationSettings';
import { fetchPushSettings, removePushSubscription, savePushSubscription } from './api';

vi.mock('./api', () => ({
  fetchPushSettings: vi.fn(),
  removePushSubscription: vi.fn(),
  savePushSubscription: vi.fn(),
}));

const endpoint = 'https://fcm.googleapis.com/push/phone';
const subscription = {
  endpoint,
  options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
  unsubscribe: vi.fn(),
  toJSON: () => ({ endpoint, keys: { p256dh: 'public', auth: 'secret' } }),
};
const getSubscription = vi.fn();
const subscribe = vi.fn();
const register = vi.fn();
const requestPermission = vi.fn();
let host: HTMLDivElement;
let dispose: () => void;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('PushManager', vi.fn());
  vi.stubGlobal('Notification', { permission: 'default', requestPermission });
  const registration = { pushManager: { getSubscription, subscribe } };
  vi.stubGlobal('navigator', {
    serviceWorker: { register, ready: Promise.resolve(registration) },
  });
  register.mockResolvedValue(registration);
  getSubscription.mockResolvedValue(null);
  subscribe.mockResolvedValue(subscription);
  subscription.unsubscribe.mockResolvedValue(true);
  requestPermission.mockResolvedValue('granted');
  vi.mocked(fetchPushSettings).mockResolvedValue({ publicKey: 'AQID', endpoint: null });
  vi.mocked(savePushSubscription).mockResolvedValue({ ok: true });
  vi.mocked(removePushSubscription).mockResolvedValue({ ok: true });
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  dispose?.();
  host.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  dispose = render(() => <NotificationSettings />, host);
  if (window.isSecureContext) await vi.waitFor(() => expect(button().disabled).toBe(false));
}

function button(): HTMLButtonElement {
  const element = host.querySelector('button');
  if (!element) throw new Error('Missing notification button');
  return element;
}

it('explains HTTPS without registering a worker or requesting permission over HTTP', async () => {
  vi.stubGlobal('isSecureContext', false);
  await mount();
  expect(host.textContent).toContain('HTTPS');
  expect(register).not.toHaveBeenCalled();
  expect(requestPermission).not.toHaveBeenCalled();
  expect(fetchPushSettings).not.toHaveBeenCalled();
});

it('only requests permission on a tap and enables after the server saves the subscription', async () => {
  await mount();
  expect(requestPermission).not.toHaveBeenCalled();
  expect(register).toHaveBeenCalledWith('/sw.js', { updateViaCache: 'none' });
  let finish: ((value: { ok: true }) => void) | undefined;
  vi.mocked(savePushSubscription).mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  button().click();
  expect(requestPermission).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(savePushSubscription).toHaveBeenCalledWith(subscription.toJSON()));
  expect(host.textContent).not.toContain('· On');
  expect(subscribe).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: new Uint8Array([1, 2, 3]),
  });
  finish?.({ ok: true });
  await vi.waitFor(() => expect(host.textContent).toContain('· On'));
});

it('leaves subscriptions untouched when permission is denied and explains how to unblock', async () => {
  requestPermission.mockResolvedValue('denied');
  await mount();
  button().click();
  await vi.waitFor(() => expect(host.textContent).toContain('Notifications are blocked'));
  expect(subscribe).not.toHaveBeenCalled();
  expect(savePushSubscription).not.toHaveBeenCalled();
  expect(button().disabled).toBe(true);
});

it('does not claim notifications are enabled when saving fails and permits retry', async () => {
  vi.mocked(savePushSubscription).mockRejectedValueOnce(new Error('offline'));
  await mount();
  button().click();
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  expect(host.textContent).not.toContain('· On');
  getSubscription.mockResolvedValue(subscription);
  button().click();
  await vi.waitFor(() => expect(host.textContent).toContain('· On'));
  expect(subscribe).toHaveBeenCalledTimes(1);
});

it('restores enabled state and removes server delivery before unsubscribing', async () => {
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
  getSubscription.mockResolvedValue(subscription);
  vi.mocked(fetchPushSettings).mockResolvedValue({ publicKey: 'AQID', endpoint });
  await mount();
  expect(host.textContent).toContain('· On');
  button().click();
  await vi.waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalledOnce());
  expect(removePushSubscription).toHaveBeenCalledWith(endpoint);
  expect(host.textContent).not.toContain('· On');
  expect(requestPermission).not.toHaveBeenCalled();
});

it('keeps the enabled state and browser subscription if server removal fails', async () => {
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
  getSubscription.mockResolvedValue(subscription);
  vi.mocked(fetchPushSettings).mockResolvedValue({ publicKey: 'AQID', endpoint });
  vi.mocked(removePushSubscription).mockRejectedValue(new Error('offline'));
  await mount();
  button().click();
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  expect(host.textContent).toContain('· On');
  expect(subscription.unsubscribe).not.toHaveBeenCalled();
});

it('requires re-enabling a local subscription that is absent from the server', async () => {
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
  getSubscription.mockResolvedValue(subscription);
  await mount();
  expect(host.textContent).not.toContain('· On');
  button().click();
  await vi.waitFor(() => expect(host.textContent).toContain('· On'));
  expect(savePushSubscription).toHaveBeenCalledWith(subscription.toJSON());
  expect(subscribe).not.toHaveBeenCalled();
});

it('replaces a subscription if the computer had to regenerate its push keys', async () => {
  getSubscription.mockResolvedValue(subscription);
  vi.mocked(fetchPushSettings).mockResolvedValue({ publicKey: 'BAUG', endpoint: null });
  await mount();
  button().click();
  await vi.waitFor(() => expect(host.textContent).toContain('· On'));
  expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: new Uint8Array([4, 5, 6]),
  });
});

it('allows retrying initialization after a connection error', async () => {
  vi.mocked(fetchPushSettings).mockRejectedValueOnce(new Error('offline'));
  await mount();
  expect(button().textContent).toBe('Retry notification setup');
  button().click();
  await vi.waitFor(() => expect(button().textContent).toBe('Enable notifications'));
  expect(requestPermission).not.toHaveBeenCalled();
});
