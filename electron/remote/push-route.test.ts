import { createECDH, randomBytes } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import http from 'http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import webPush from 'web-push';
import type { RemoteAttentionState } from './protocol.js';

vi.mock('../ipc/pty.js', () => ({
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(),
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => ['agent']),
  getAgentMeta: vi.fn(() => ({ taskId: 'task', isShell: false })),
  getAgentCols: vi.fn(() => 80),
  getAgentRows: vi.fn(() => 24),
  onPtyEvent: vi.fn(() => vi.fn()),
}));
vi.mock('web-push', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof webPush }>();
  return { default: { ...actual.default, sendNotification: vi.fn(async () => ({})) } };
});
const { startRemoteServer } = await import('./server.js');
const pty = await import('../ipc/pty.js');
let server: Awaited<ReturnType<typeof startRemoteServer>>;
let directory: string;
let attention: RemoteAttentionState;
const ecdh = createECDH('prime256v1');
const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/capability',
  keys: {
    p256dh: ecdh.generateKeys().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  },
};

async function start() {
  server = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: directory,
    getTaskName: () => 'Task name',
    getTaskAttention: () => attention,
    getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
    getCoordinator: () => null,
  });
  server.enableRememberedDevices(join(directory, 'paired-phones.json'));
}
function request(method: string, token: string, body?: unknown, origin?: string) {
  return fetch(`http://127.0.0.1:${server.port}/api/mobile/push`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function pair(remember = false): Promise<string> {
  const { pin } = server.generatePairingPin();
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pair/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.mobileToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin, remember }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}
function updateAttention(value: RemoteAttentionState) {
  attention = value;
  const listener = vi
    .mocked(pty.onPtyEvent)
    .mock.calls.find(([name]) => name === 'list-changed')?.[1];
  if (!listener) throw new Error('Missing list listener');
  listener('');
}

beforeEach(async () => {
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), 'push-route-'));
  attention = 'active';
  await start();
});
afterEach(async () => {
  await server.stop();
  rmSync(directory, { recursive: true, force: true });
});

it('requires a paired token and the same browser origin', async () => {
  for (const token of [server.mobileToken, server.token, server.subtaskToken]) {
    expect((await request('GET', token)).status).toBe(403);
  }
  expect((await request('GET', 'invalid')).status).toBe(401);
  const token = await pair();
  expect((await request('GET', token, undefined, 'https://evil.example')).status).toBe(403);
  expect((await request('GET', token)).status).toBe(200);
});

it('registers and removes only the authenticated phone subscription', async () => {
  const token = await pair();
  const other = await pair();
  expect((await request('PUT', token, subscription)).status).toBe(200);
  expect((await request('DELETE', other, { endpoint: subscription.endpoint })).status).toBe(200);
  expect(await (await request('GET', token)).json()).toMatchObject({
    endpoint: subscription.endpoint,
  });
  expect(await (await request('GET', other)).json()).toMatchObject({ endpoint: null });
  expect((await request('DELETE', token, { endpoint: subscription.endpoint })).status).toBe(200);
  expect(await (await request('GET', token)).json()).toMatchObject({ endpoint: null });
});

it('rejects invalid subscriptions and oversized request bodies', async () => {
  const token = await pair();
  for (const body of [
    null,
    {},
    { ...subscription, endpoint: 'https://127.0.0.1/secret' },
    { ...subscription, keys: { auth: 'short', p256dh: 'short' } },
    { ...subscription, padding: 'x'.repeat(5000) },
  ]) {
    expect((await request('PUT', token, body)).status).toBe(400);
  }
});

it('integrates desktop status events with push and revokes immediately', async () => {
  const token = await pair(true);
  await request('PUT', token, subscription);
  updateAttention('needs_input');
  updateAttention('needs_input');
  await vi.waitFor(() => expect(webPush.sendNotification).toHaveBeenCalledTimes(1));
  server.forgetRememberedDevices();
  expect((await request('GET', token)).status).toBe(401);
  updateAttention('active');
  updateAttention('needs_input');
  expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
});

it('rejects a subscription body completed after its phone was revoked', async () => {
  const token = await pair(true);
  const body = JSON.stringify(subscription);
  const incoming = http.request({
    hostname: '127.0.0.1',
    port: server.port,
    path: '/api/mobile/push',
    method: 'PUT',
    agent: false,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Expect: '100-continue',
    },
  });
  const response = new Promise<number>((resolve, reject) => {
    incoming.on('error', reject);
    incoming.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
  });
  const accepted = new Promise<void>((resolve) => incoming.once('continue', resolve));
  incoming.flushHeaders();
  await accepted;
  incoming.write(body.slice(0, -1));
  server.forgetRememberedDevices();
  incoming.end(body.slice(-1));
  expect(await response).toBe(401);
  updateAttention('needs_input');
  expect(webPush.sendNotification).not.toHaveBeenCalled();
});

it('restores opted-in phones across restart with a stable signing key', async () => {
  const token = await pair(true);
  const before: unknown = await (await request('GET', token)).json();
  await request('PUT', token, subscription);
  await server.stop();
  await start();
  expect(await (await request('GET', token)).json()).toEqual({
    ...(before as object),
    endpoint: subscription.endpoint,
  });
  await server.stop(true);
  await start();
  expect((await request('GET', token)).status).toBe(401);
  const fresh = await pair();
  expect(await (await request('GET', fresh)).json()).toEqual(before);
});

it('serves the stable worker URL with revalidation', async () => {
  writeFileSync(join(directory, 'sw.js'), '// worker');
  const response = await fetch(`http://127.0.0.1:${server.port}/sw.js`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-cache');
});
