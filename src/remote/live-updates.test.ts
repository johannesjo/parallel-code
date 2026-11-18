// The phone's live terminal from end to end: the real phone server and the
// real phone web client over a real socket, with only the PTYs faked. Each
// step is a way the stream has stopped before: the network dropping, the
// agent's PTY restarting under the same ID, and the desktop resizing it.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

type Rendered = (snapshot: { data: string; cols: number; rows: number } | null) => void;
interface PtyWatcher {
  onSnapshot: Rendered;
  onOutput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

// Every subscription the server opened on a fake PTY, and the PTY event listeners.
const pty = vi.hoisted(() => ({
  watchers: [] as {
    agentId: string;
    watcher: unknown;
    subscriber: (encoded: string) => void;
    unsubscribed: boolean;
  }[],
  listeners: new Map<string, (agentId: string, data?: unknown) => void>(),
}));

vi.mock('../../electron/ipc/pty.js', () => ({
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  setAgentRemoteSize: vi.fn(),
  scrollAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(),
  // Like the real one: returns the subscriber that unsubscribeFromAgent later takes back.
  subscribeToAgentRendered: vi.fn(
    (agentId: string, onSnapshot: Rendered, callbacks: Omit<PtyWatcher, 'onSnapshot'>) => {
      const subscriber = (encoded: string) => callbacks.onOutput(encoded);
      const watcher = { onSnapshot, ...callbacks };
      pty.watchers.push({ agentId, watcher, subscriber, unsubscribed: false });
      return subscriber;
    },
  ),
  unsubscribeFromAgent: vi.fn((_agentId: string, cb: (encoded: string) => void) => {
    for (const entry of pty.watchers) if (entry.subscriber === cb) entry.unsubscribed = true;
  }),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => ['agent-1']),
  getAgentMeta: vi.fn(() => null),
  getAgentCols: vi.fn(() => 80),
  getAgentRows: vi.fn(() => 24),
  onPtyEvent: vi.fn((event: string, listener: (agentId: string, data?: unknown) => void) => {
    pty.listeners.set(event, listener);
    return vi.fn();
  }),
}));

const { startRemoteServer } = await import('../../electron/remote/server.js');

const b64 = (text: string) => Buffer.from(text).toString('base64');

/** The newest open subscription on the fake PTY, once the server has made it. */
async function liveWatcher(count: number): Promise<PtyWatcher> {
  await vi.waitFor(() => expect(pty.watchers.length).toBe(count));
  const entry = pty.watchers[count - 1];
  expect(entry.unsubscribed).toBe(false);
  return entry.watcher as PtyWatcher;
}

let srv: Awaited<ReturnType<typeof startRemoteServer>>;
let client: typeof import('./ws');
const seen: string[] = [];
const storage = new Map<string, string>();

beforeAll(async () => {
  srv = await startRemoteServer({
    port: 0,
    host: '0.0.0.0',
    staticDir: '/nonexistent',
    getTaskName: (id) => id,
    getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
    getCoordinator: () => null,
  });
  storage.set('parallel-code-token', srv.mobileToken);
  vi.stubGlobal('sessionStorage', { getItem: () => null, removeItem: vi.fn() });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal('window', { location: { protocol: 'http:', host: `127.0.0.1:${srv.port}` } });
  vi.stubGlobal('WebSocket', WebSocket);

  client = await import('./ws');
  client.onScrollback('agent-1', (data, cols, rows) =>
    seen.push(`snapshot ${Buffer.from(data, 'base64').toString()} ${cols}x${rows}`),
  );
  client.onOutput('agent-1', (data) =>
    seen.push(`output ${Buffer.from(data, 'base64').toString()}`),
  );
  client.onTerminalSize('agent-1', (cols, rows) => seen.push(`size ${cols}x${rows}`));
  client.connect();
  await vi.waitFor(() => expect(client.status()).toBe('connected'));
  client.subscribeAgent('agent-1');
});

afterAll(async () => {
  // Without a token the client stops reconnecting once the server is gone.
  storage.clear();
  await srv.stop();
  vi.unstubAllGlobals();
});

// The steps run in order as one phone session; each picks up where the last left off.
describe('phone live terminal', () => {
  it('shows the screen, then the output that follows', async () => {
    const pty1 = await liveWatcher(1);
    pty1.onSnapshot({ data: b64('$ npm test'), cols: 80, rows: 24 });
    pty1.onOutput(b64('PASS'));
    await vi.waitFor(() => expect(seen).toEqual(['snapshot $ npm test 80x24', 'output PASS']));
  });

  it('follows the desktop resizing the terminal', async () => {
    const pty1 = await liveWatcher(1);
    pty1.onResize(120, 40);
    await vi.waitFor(() => expect(seen.at(-1)).toBe('size 120x40'));
  });

  it('streams again after the network drops, from a fresh screen', async () => {
    seen.length = 0;
    // Moving to another interface drops every phone, as a network change does.
    await srv.rebind('127.0.0.1');
    await vi.waitFor(() => expect(client.status()).toBe('disconnected'));
    await vi.waitFor(() => expect(client.status()).toBe('connected'), { timeout: 10_000 });

    const pty2 = await liveWatcher(2);
    expect(pty.watchers[0].unsubscribed).toBe(true);
    pty2.onSnapshot({ data: b64('$ npm test\r\nPASS'), cols: 120, rows: 40 });
    pty2.onOutput(b64('done'));
    await vi.waitFor(() =>
      expect(seen).toEqual(['snapshot $ npm test\r\nPASS 120x40', 'output done']),
    );
  }, 15_000);

  it('streams the new PTY when the agent restarts under the same ID', async () => {
    seen.length = 0;
    pty.listeners.get('spawn')?.('agent-1');
    const pty3 = await liveWatcher(3);
    expect(pty.watchers[1].unsubscribed).toBe(true);
    pty3.onSnapshot({ data: b64('restarted'), cols: 80, rows: 24 });
    pty3.onOutput(b64('hello'));
    await vi.waitFor(() => expect(seen).toEqual(['snapshot restarted 80x24', 'output hello']));
  });

  it('stops streaming once the phone leaves the terminal', async () => {
    client.unsubscribeAgent('agent-1');
    await vi.waitFor(() => expect(pty.watchers[2].unsubscribed).toBe(true));
  });
});
