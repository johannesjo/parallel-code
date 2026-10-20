import { createECDH, randomBytes } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import webPush from 'web-push';
import { createMobilePush, parsePushSubscription } from './push.js';
import * as atomic from '../mcp/atomic.js';
import type { RemoteAgent } from './protocol.js';

vi.mock('web-push', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof webPush }>();
  return { default: { ...actual.default, sendNotification: vi.fn(async () => ({})) } };
});

const ecdh = createECDH('prime256v1');
const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/opaque-capability',
  keys: {
    p256dh: ecdh.generateKeys().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  },
};
const owner = 'a'.repeat(64);
const other = 'b'.repeat(64);
let directory: string;
let valid: Set<string>;
let push: ReturnType<typeof createMobilePush>;
const agent = (attention: RemoteAgent['attention'], taskId = 'task'): RemoteAgent => ({
  taskId,
  agentId: taskId,
  taskName: 'Task name',
  status: 'running',
  exitCode: null,
  lastLine: '',
  attention,
});

beforeEach(() => {
  vi.mocked(webPush.sendNotification)
    .mockReset()
    .mockResolvedValue({ statusCode: 201, body: '', headers: {} });
  directory = mkdtempSync(join(tmpdir(), 'mobile-push-'));
  valid = new Set([owner, other]);
  push = createMobilePush((hash) => valid.has(hash));
  push.enable(join(directory, 'phone-push.json'), []);
});

afterEach(() => {
  vi.restoreAllMocks();
  push.stop();
  rmSync(directory, { recursive: true, force: true });
});

describe('push subscription validation', () => {
  it.each([
    'http://fcm.googleapis.com/send/id',
    'https://localhost/send/id',
    'https://127.0.0.1/send/id',
    'https://fcm.googleapis.com.evil.example/send/id',
    'https://evilpush.apple.com/send/id',
    'https://user:password@fcm.googleapis.com/send/id',
    'https://fcm.googleapis.com:444/send/id',
    'https://fcm.googleapis.com/send/id#fragment',
  ])('rejects unsafe endpoint %s', (endpoint) => {
    expect(() => parsePushSubscription({ ...subscription, endpoint })).toThrow();
  });
  it.each([
    'https://updates.push.services.mozilla.com/wpush/v2/id',
    'https://web.push.apple.com/id',
  ])('accepts provider %s', (endpoint) => {
    expect(parsePushSubscription({ ...subscription, endpoint }).endpoint).toBe(endpoint);
  });
  it('checks key lengths, base64url encoding and the actual elliptic curve point', () => {
    for (const keys of [
      { ...subscription.keys, auth: 'short' },
      { ...subscription.keys, p256dh: Buffer.alloc(65, 4).toString('base64url') },
      { ...subscription.keys, auth: subscription.keys.auth + '=' },
    ])
      expect(() => parsePushSubscription({ ...subscription, keys })).toThrow();
  });
});

it('keeps signing keys stable, saves privately, and only restores remembered owners', () => {
  const publicKey = push.status(owner).publicKey;
  push.replace(owner, subscription);
  push.replace(other, { ...subscription, endpoint: 'https://web.push.apple.com/other' });
  const path = join(directory, 'phone-push.json');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, 'utf8')).not.toContain('Bearer');
  const restored = createMobilePush((hash) => valid.has(hash));
  restored.enable(path, [owner]);
  expect(restored.status(owner)).toEqual({ publicKey, endpoint: subscription.endpoint });
  expect(restored.status(other).endpoint).toBeNull();
  restored.revoke();
  expect(restored.status(owner)).toEqual({ publicKey, endpoint: null });
});

it('cannot unsubscribe another phone and removes evicted owners', () => {
  push.replace(owner, subscription);
  push.remove(other, subscription.endpoint);
  expect(push.status(owner).endpoint).toBe(subscription.endpoint);
  valid.delete(owner);
  push.retainOwners();
  expect(push.status(owner).endpoint).toBeNull();
  expect(() => push.replace(owner, subscription)).toThrow('Phone disconnected');
});

it('transfers an existing endpoint when the same phone pairs again', async () => {
  push.replace(owner, subscription);
  push.replace(other, subscription);
  expect(push.status(owner).endpoint).toBeNull();
  expect(push.status(other).endpoint).toBe(subscription.endpoint);
  push.snapshot([agent('active')]);
  push.snapshot([agent('needs_input')]);
  await vi.waitFor(() => expect(webPush.sendNotification).toHaveBeenCalledTimes(1));
});

it('baselines tasks, deduplicates repeated snapshots, and notifies reentry', async () => {
  push.replace(owner, subscription);
  push.snapshot([agent('needs_input')]);
  expect(webPush.sendNotification).not.toHaveBeenCalled();
  push.snapshot([agent('active')]);
  push.snapshot([agent('needs_input'), { ...agent('needs_input'), agentId: 'second-terminal' }]);
  push.snapshot([agent('needs_input')]);
  await vi.waitFor(() => expect(webPush.sendNotification).toHaveBeenCalledTimes(1));
  expect(JSON.parse(vi.mocked(webPush.sendNotification).mock.calls[0][1] as string)).toEqual({
    taskId: 'task',
    taskName: 'Task name',
  });
  push.snapshot([agent('active')]);
  push.snapshot([agent('needs_input')]);
  await vi.waitFor(() => expect(webPush.sendNotification).toHaveBeenCalledTimes(2));
});

it('ignores exited tasks and stops delivery', () => {
  push.replace(owner, subscription);
  push.snapshot([agent('active')]);
  push.snapshot([{ ...agent('needs_input'), status: 'exited' }]);
  push.snapshot([]);
  push.stop();
  push.snapshot([agent('active')]);
  push.snapshot([agent('needs_input')]);
  expect(webPush.sendNotification).not.toHaveBeenCalled();
});

it('alerts when a new task first appears needing input after the startup baseline', async () => {
  push.replace(owner, subscription);
  push.snapshot([]);
  push.snapshot([agent('needs_input', 'new')]);
  await vi.waitFor(() => expect(webPush.sendNotification).toHaveBeenCalledTimes(1));
});

it('keeps the subscription when unsubscribe persistence fails', () => {
  push.replace(owner, subscription);
  vi.spyOn(atomic, 'atomicWriteFileSync').mockImplementationOnce(() => {
    throw new Error('ENOSPC');
  });
  expect(() => push.remove(owner, subscription.endpoint)).toThrow('ENOSPC');
  expect(push.status(owner).endpoint).toBe(subscription.endpoint);
});

it.each([404, 410])('prunes expired subscriptions after status %i', async (statusCode) => {
  vi.mocked(webPush.sendNotification).mockRejectedValue({ statusCode });
  push.replace(owner, subscription);
  push.snapshot([agent('active')]);
  push.snapshot([agent('needs_input')]);
  await vi.waitFor(() => expect(push.status(owner).endpoint).toBeNull());
  const restored = createMobilePush((hash) => valid.has(hash));
  restored.enable(join(directory, 'phone-push.json'), [owner]);
  expect(restored.status(owner).endpoint).toBeNull();
});

it('serializes pending deliveries and stops queued work when a phone is revoked', async () => {
  let finish: (() => void) | undefined;
  vi.mocked(webPush.sendNotification).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ statusCode: 201, body: '', headers: {} });
      }),
  );
  push.replace(owner, subscription);
  push.snapshot([agent('active', 'first'), agent('active', 'second')]);
  push.snapshot([agent('needs_input', 'first'), agent('needs_input', 'second')]);
  expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
  valid.clear();
  push.revoke();
  finish?.();
  await Promise.resolve();
  expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
});

it.each(['active', 'removed'])('drops queued requests when a task becomes %s', async (state) => {
  let finish: (() => void) | undefined;
  vi.mocked(webPush.sendNotification).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ statusCode: 201, body: '', headers: {} });
      }),
  );
  push.replace(owner, subscription);
  push.snapshot([agent('active', 'first'), agent('active', 'second')]);
  push.snapshot([agent('needs_input', 'first'), agent('needs_input', 'second')]);
  push.snapshot([
    agent('needs_input', 'first'),
    ...(state === 'active' ? [agent('active', 'second')] : []),
  ]);
  finish?.();
  await Promise.resolve();
  expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
});
