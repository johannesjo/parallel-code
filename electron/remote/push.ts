import { createECDH, ECDH } from 'crypto';
import { existsSync, readFileSync, rmSync } from 'fs';
import webPush, { type PushSubscription } from 'web-push';
import { atomicWriteFileSync } from '../mcp/atomic.js';
import { warn } from '../log.js';
import type { RemoteAgent, RemoteAttentionState } from './protocol.js';

const VAPID_SUBJECT = 'https://github.com/johannesjo/parallel-code';

function keyBytes(value: unknown, length: number): Buffer | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length === length && bytes.toString('base64url') === value) return bytes;
}

/** Push endpoints are capability URLs, not arbitrary destinations for HTTP requests. */
export function parsePushSubscription(value: unknown): PushSubscription {
  if (!value || typeof value !== 'object') throw new Error('Invalid push subscription');
  const { endpoint, keys } = value as Record<string, unknown>;
  if (typeof endpoint !== 'string' || endpoint.length > 2048)
    throw new Error('Invalid push endpoint');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Invalid push endpoint');
  }
  const host = url.hostname;
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !(
      host === 'fcm.googleapis.com' ||
      host === 'push.services.mozilla.com' ||
      host.endsWith('.push.services.mozilla.com') ||
      host.endsWith('.push.apple.com')
    )
  )
    throw new Error('Unsupported push endpoint');
  if (!keys || typeof keys !== 'object') throw new Error('Invalid push keys');
  const { p256dh, auth } = keys as Record<string, unknown>;
  const publicKey = keyBytes(p256dh, 65);
  if (!publicKey || publicKey[0] !== 4 || !keyBytes(auth, 16)) throw new Error('Invalid push keys');
  try {
    ECDH.convertKey(publicKey, 'prime256v1');
  } catch {
    throw new Error('Invalid push keys');
  }
  return { endpoint, keys: { p256dh: p256dh as string, auth: auth as string } };
}

/** One subscription per paired phone; no bearer credentials enter this store. */
export function createMobilePush(isOwnerValid: (hash: string) => boolean) {
  let path: string | undefined;
  let keys: { publicKey: string; privateKey: string } | undefined;
  const subscriptions = new Map<string, PushSubscription>();
  const previous = new Map<string, RemoteAttentionState>();
  const pending = new Map<string, Map<string, { taskId: string; taskName: string }>>();
  const sending = new Set<string>();
  let stopped = false;
  let initialized = false;

  function save(): void {
    if (!path) throw new Error('Phone notifications unavailable');
    atomicWriteFileSync(
      path,
      JSON.stringify({ keys, subscriptions: Object.fromEntries(subscriptions) }),
      { mode: 0o600 },
    );
  }

  function saveSafely(): void {
    try {
      save();
    } catch {
      warn('remote', 'Could not save phone notification settings');
    }
  }

  async function deliver(owner: string): Promise<void> {
    if (sending.has(owner)) return;
    sending.add(owner);
    const queue = pending.get(owner);
    try {
      while (!stopped && isOwnerValid(owner) && queue?.size) {
        const subscription = subscriptions.get(owner);
        const payload = queue.values().next().value;
        if (!subscription || !keys || !payload) break;
        queue.delete(payload.taskId);
        try {
          await webPush.sendNotification(subscription, JSON.stringify(payload), {
            vapidDetails: { subject: VAPID_SUBJECT, ...keys },
            TTL: 60,
            timeout: 5000,
            urgency: 'high',
          });
        } catch (error) {
          const status =
            error && typeof error === 'object' && 'statusCode' in error
              ? error.statusCode
              : undefined;
          if (status === 404 || status === 410) {
            // A phone may replace its subscription while this request is in flight.
            if (subscriptions.get(owner) === subscription) {
              subscriptions.delete(owner);
              saveSafely();
            }
          } else warn('remote', 'Could not deliver a phone notification');
        }
      }
    } finally {
      sending.delete(owner);
      if (pending.get(owner) === queue) pending.delete(owner);
      else if (!stopped && isOwnerValid(owner)) void deliver(owner);
    }
  }

  return {
    enable(filePath: string, rememberedOwners: readonly string[]): void {
      if (path === filePath) return;
      path = filePath;
      if (!existsSync(filePath)) return;
      try {
        const stored: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
        if (!stored || typeof stored !== 'object') throw new Error('Invalid settings');
        const saved = stored as Record<string, unknown>;
        const vapid = saved.keys as Record<string, unknown> | undefined;
        const publicKey = keyBytes(vapid?.publicKey, 65);
        const privateKey = keyBytes(vapid?.privateKey, 32);
        if (!publicKey || !privateKey) throw new Error('Invalid keys');
        const ecdh = createECDH('prime256v1');
        ecdh.setPrivateKey(privateKey);
        if (!ecdh.getPublicKey().equals(publicKey)) throw new Error('Invalid keys');
        keys = {
          publicKey: publicKey.toString('base64url'),
          privateKey: privateKey.toString('base64url'),
        };
        if (saved.subscriptions && typeof saved.subscriptions === 'object') {
          for (const [owner, value] of Object.entries(saved.subscriptions)) {
            if (rememberedOwners.includes(owner) && isOwnerValid(owner)) {
              try {
                subscriptions.set(owner, parsePushSubscription(value));
              } catch {
                /* A damaged subscription does not invalidate other phones. */
              }
            }
          }
        }
      } catch {
        keys = undefined;
        subscriptions.clear();
        warn('remote', 'Could not restore phone notification settings');
      }
    },
    status(owner: string): { publicKey: string; endpoint: string | null } {
      if (!path) throw new Error('Phone notifications unavailable');
      if (!keys) {
        keys = webPush.generateVAPIDKeys();
        try {
          save();
        } catch (error) {
          keys = undefined;
          throw error;
        }
      }
      return { publicKey: keys.publicKey, endpoint: subscriptions.get(owner)?.endpoint ?? null };
    },
    replace(owner: string, value: unknown): void {
      const subscription = parsePushSubscription(value);
      if (stopped || !isOwnerValid(owner)) throw new Error('Phone disconnected');
      // Generate and persist the signing key before accepting a subscription.
      this.status(owner);
      const old = new Map(subscriptions);
      // Re-pairing this browser changes its token, but not necessarily its push endpoint.
      // Transfer delivery to the new owner so the same phone does not receive two alerts.
      for (const [other, saved] of subscriptions) {
        if (saved.endpoint === subscription.endpoint) subscriptions.delete(other);
      }
      subscriptions.set(owner, subscription);
      try {
        save();
      } catch (error) {
        subscriptions.clear();
        for (const [hash, saved] of old) subscriptions.set(hash, saved);
        throw error;
      }
      for (const hash of old.keys()) if (!subscriptions.has(hash)) pending.delete(hash);
    },
    remove(owner: string, endpoint: unknown): void {
      if (typeof endpoint !== 'string') throw new Error('Invalid push endpoint');
      const subscription = subscriptions.get(owner);
      if (!subscription || subscription.endpoint !== endpoint) return;
      subscriptions.delete(owner);
      try {
        save();
      } catch (error) {
        subscriptions.set(owner, subscription);
        throw error;
      }
      pending.delete(owner);
    },
    retainOwners(): void {
      let changed = false;
      for (const owner of subscriptions.keys()) {
        if (!isOwnerValid(owner)) {
          subscriptions.delete(owner);
          pending.delete(owner);
          changed = true;
        }
      }
      if (changed) saveSafely();
    },
    revoke(): void {
      subscriptions.clear();
      pending.clear();
      if (!path) return;
      try {
        save();
      } catch {
        // Fail closed on next start too, as the paired credentials do.
        try {
          rmSync(path, { force: true });
        } catch {
          warn('remote', 'Could not clear saved phone notification settings');
        }
      }
    },
    snapshot(agents: readonly RemoteAgent[]): void {
      const current = new Map(agents.map((agent) => [agent.taskId, agent]));
      const baseline = !initialized;
      initialized = true;
      for (const queue of pending.values()) {
        for (const taskId of queue.keys()) {
          const agent = current.get(taskId);
          if (agent?.status !== 'running' || agent.attention !== 'needs_input')
            queue.delete(taskId);
        }
      }
      for (const [taskId, agent] of current) {
        const before = previous.get(taskId);
        previous.set(taskId, agent.attention);
        if (
          stopped ||
          baseline ||
          before === 'needs_input' ||
          agent.attention !== 'needs_input' ||
          agent.status !== 'running'
        )
          continue;
        for (const owner of subscriptions.keys()) {
          if (!isOwnerValid(owner)) continue;
          let queue = pending.get(owner);
          if (!queue) pending.set(owner, (queue = new Map()));
          // Bound work even if many tasks need input over a failing connection.
          if (queue.size < 32)
            queue.set(taskId, { taskId, taskName: agent.taskName.slice(0, 200) });
          void deliver(owner);
        }
      }
      for (const taskId of previous.keys()) if (!current.has(taskId)) previous.delete(taskId);
    },
    stop(): void {
      stopped = true;
      pending.clear();
    },
  };
}
