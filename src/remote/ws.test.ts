import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Record<string, unknown>[] = [];
  constructor() {
    Socket.instances.push(this);
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = Socket.OPEN;
    this.onopen?.();
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  disconnect(code = 1006) {
    this.close();
    this.onclose?.({ code });
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  Socket.instances = [];
  const storage = new Map([
    ['parallel-code-token', 'watch'],
    ['parallel-code-paired-token', 'control'],
  ]);
  vi.stubGlobal('sessionStorage', { getItem: () => null, removeItem: vi.fn() });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost:7777' } });
  vi.stubGlobal('WebSocket', Socket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function connected() {
  const client = await import('./ws');
  client.connect();
  const socket = Socket.instances[0];
  socket.open();
  socket.receive({ type: 'agents', list: [] });
  return { client, socket };
}

describe('phone message delivery', () => {
  it('reconnects and subscribes for fresh scrollback after the server terminates a slow socket', async () => {
    const { client, socket } = await connected();
    const stopOutput = client.onOutput('agent-1', vi.fn());
    const scrollback = vi.fn();
    const stopScrollback = client.onScrollback('agent-1', scrollback);
    socket.disconnect(1006);
    await vi.advanceTimersByTimeAsync(3000);
    const replacement = Socket.instances[1];
    replacement.open();
    expect(replacement.sent).toContainEqual({ type: 'auth', token: 'control' });
    expect(replacement.sent).toContainEqual({ type: 'subscribe', agentId: 'agent-1' });
    replacement.receive({
      type: 'scrollback',
      agentId: 'agent-1',
      data: 'ZnJlc2g=',
      cols: 80,
      rows: 24,
    });
    expect(scrollback).toHaveBeenCalledWith('ZnJlc2g=', 80, 24);
    stopOutput();
    stopScrollback();
  });

  it.each([false, true])('recovers a stalled handshake (socket open: %s)', async (opened) => {
    const client = await import('./ws');
    client.connect();
    const stalled = Socket.instances[0];
    if (opened) stalled.open();
    await vi.advanceTimersByTimeAsync(10000);
    expect(client.status()).toBe('disconnected');
    expect(stalled.readyState).toBe(3);
    expect(localStorage.getItem('parallel-code-paired-token')).toBe('control');
    await vi.advanceTimersByTimeAsync(3000);
    const replacement = Socket.instances[1];
    replacement.open();
    replacement.receive({ type: 'agents', list: [] });
    // Late events from the abandoned connection must not affect its replacement.
    stalled.disconnect(4001);
    expect(client.status()).toBe('connected');
    expect(client.canControl()).toBe(true);
    await vi.advanceTimersByTimeAsync(20000);
    expect(Socket.instances).toHaveLength(2);
    expect(client.status()).toBe('connected');
  });

  it('cancels the previous handshake deadline on manual retry', async () => {
    const client = await import('./ws');
    client.connect();
    await vi.advanceTimersByTimeAsync(9000);
    client.reconnect();
    const replacement = Socket.instances[1];
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.status()).toBe('connecting');
    expect(replacement.readyState).toBe(Socket.CONNECTING);
    replacement.open();
    replacement.receive({ type: 'agents', list: [] });
    await vi.advanceTimersByTimeAsync(10000);
    expect(client.status()).toBe('connected');
  });

  it('waits for authentication before enabling control', async () => {
    const client = await import('./ws');
    client.connect();
    const socket = Socket.instances[0];
    socket.open();
    expect(client.status()).toBe('connecting');
    expect(client.canControl()).toBe(false);
    await expect(client.sendInput('a', 'hello')).rejects.toThrow('Reconnect');
    socket.receive({ type: 'agents', list: [] });
    expect(client.canControl()).toBe(true);
  });
  it('waits for the matching acknowledgment', async () => {
    const { client, socket } = await connected();
    const resolved = vi.fn();
    const pending = client.sendInput('a', 'hello', { submit: true }).then(resolved);
    const requestId = socket.sent.at(-1)?.requestId;
    socket.receive({ type: 'input-result', requestId: 'different', ok: true });
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    socket.receive({ type: 'input-result', requestId, ok: true });
    await pending;
    expect(resolved).toHaveBeenCalledOnce();
  });
  it('surfaces rejection without automatically retrying', async () => {
    const { client, socket } = await connected();
    const pending = client.sendInput('a', 'hello');
    const rejected = expect(pending).rejects.toThrow('Agent is gone');
    socket.receive({
      type: 'input-result',
      requestId: socket.sent.at(-1)?.requestId,
      ok: false,
      error: 'Agent is gone',
    });
    await rejected;
    expect(socket.sent.filter((m) => m.type === 'input')).toHaveLength(1);
  });
  it('reports uncertain delivery on a disconnect and never replays the input', async () => {
    const { client, socket } = await connected();
    const pending = client.sendInput('a', 'hello', { submit: true });
    const rejected = expect(pending).rejects.toThrow('may have reached');
    socket.disconnect();
    await rejected;
    await vi.advanceTimersByTimeAsync(3000);
    const replacement = Socket.instances[1];
    replacement.open();
    replacement.receive({ type: 'agents', list: [] });
    expect(replacement.sent.filter((m) => m.type === 'input')).toHaveLength(0);
  });
  it('times out missing acknowledgments', async () => {
    const { client } = await connected();
    const rejected = expect(client.sendInput('a', 'hello')).rejects.toThrow(
      'could not be confirmed',
    );
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
  });
  it('returns to connection setup on expired credentials without reloading drafts', async () => {
    const { client, socket } = await connected();
    socket.disconnect(4001);
    await vi.advanceTimersByTimeAsync(0);
    const fallback = Socket.instances[1];
    fallback.open();
    fallback.disconnect(4001);
    expect(client.needsConnection()).toBe(true);
    expect(client.canControl()).toBe(false);
  });
});
