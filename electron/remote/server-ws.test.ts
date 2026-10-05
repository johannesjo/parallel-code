// WebSocket-level access control for the remote server.
// The QR-code (mobile) token only watches: it can subscribe to output but
// must not type, resize, or kill. Typing needs the paired token (PIN entered
// on the phone); resize and kill stay coordinator-only. Browser pages from
// any other origin are refused at the upgrade, before any token is seen.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import http from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../ipc/pty.js', () => ({
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  setAgentRemoteSize: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(),
  subscribeToAgentRendered: vi.fn(() => null),
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => []),
  getAgentMeta: vi.fn(() => null),
  getAgentCols: vi.fn(() => 80),
  getAgentRows: vi.fn(() => 24),
  onPtyEvent: vi.fn(() => vi.fn()), // returns an unsubscribe fn
}));

const pty = await import('../ipc/pty.js');
const { startRemoteServer, isBrowserOriginAllowed, buildRemoteCsp } = await import('./server.js');

let port = 0;
let coordinatorToken = '';
let mobileToken = '';
let generatePin: () => { pin: string; expiresAt: number };
let stop: () => Promise<void>;
let rebind: (host: string) => Promise<void>;
let srv: Awaited<ReturnType<typeof startRemoteServer>>;

/** Elevate the mobile token to a paired one via the desktop PIN. */
async function pair(): Promise<string> {
  const { pin } = generatePin();
  const res = await fetch(`http://127.0.0.1:${port}/api/pair/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mobileToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

beforeEach(async () => {
  srv = await startRemoteServer({
    port: 0,
    host: '0.0.0.0',
    staticDir: '/nonexistent',
    getTaskName: (id) => id,
    getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
    getCoordinator: () => null,
  });
  port = srv.port;
  rebind = srv.rebind;
  coordinatorToken = srv.token;
  mobileToken = srv.mobileToken;
  generatePin = srv.generatePairingPin;
  stop = srv.stop;
  vi.clearAllMocks();
});

afterEach(async () => {
  await stop();
});

/** Connect and authenticate; resolves once the server replies (agents list). */
function connectAndAuth(token: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.once('message', () => resolve(ws));
    ws.on('close', (code) => reject(new Error(`closed before auth ack: ${code}`)));
    ws.on('error', reject);
  });
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    // Drop connectAndAuth's rejecting close/error listeners — from here on
    // a close is the expected outcome, not a failure. Keep a no-op error
    // listener: an 'error' with no listener throws on EventEmitters.
    ws.removeAllListeners('close');
    ws.removeAllListeners('error');
    ws.on('error', () => {});
    ws.on('close', (code) => resolve(code));
  });
}

describe('coordinator agent token over WebSocket', () => {
  it('is refused, so an agent cannot type into other terminals', async () => {
    const agentToken = srv.coordinatorTokenFor('coordinator-1');
    await expect(
      connectAndAuth(agentToken, { 'X-Coordinator-Id': 'coordinator-1' }),
    ).rejects.toThrow('4001');
    await expect(
      connectAndAuth(agentToken, {
        Authorization: `Bearer ${agentToken}`,
        'X-Coordinator-Id': 'coordinator-1',
      }),
    ).rejects.toThrow('4001');
  });
});

describe('mobile token over WebSocket', () => {
  it('authenticates and can subscribe to agent output', async () => {
    const ws = await connectAndAuth(mobileToken);
    ws.send(JSON.stringify({ type: 'subscribe', agentId: 'agent-1' }));
    await vi.waitFor(() => {
      expect(pty.subscribeToAgent).toHaveBeenCalledWith('agent-1', expect.any(Function));
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('disconnects a congested terminal subscriber while healthy clients keep receiving output', async () => {
    vi.mocked(pty.subscribeToAgent).mockReturnValueOnce(true).mockReturnValueOnce(true);
    const sent = vi.spyOn(WebSocket.prototype, 'send');
    const slow = await connectAndAuth(mobileToken);
    const slowServer = sent.mock.contexts.find((socket) => socket !== slow);
    sent.mockRestore();
    if (!slowServer) throw new Error('Server socket missing');
    const healthy = await connectAndAuth(mobileToken);
    slow.send(JSON.stringify({ type: 'subscribe', agentId: 'slow-agent' }));
    healthy.send(JSON.stringify({ type: 'subscribe', agentId: 'healthy-agent' }));
    await vi.waitFor(() => expect(pty.subscribeToAgent).toHaveBeenCalledTimes(2));
    const slowOutput = vi
      .mocked(pty.subscribeToAgent)
      .mock.calls.find(([id]) => id === 'slow-agent')?.[1];
    const healthyOutput = vi
      .mocked(pty.subscribeToAgent)
      .mock.calls.find(([id]) => id === 'healthy-agent')?.[1];
    if (!slowOutput || !healthyOutput) throw new Error('Output subscriptions missing');

    // Deterministic stalled transport, without relying on OS socket buffer sizes.
    Object.defineProperty(slowServer, 'bufferedAmount', { value: 1024 * 1024 + 1 });
    const closed = waitForClose(slow);
    slowOutput('c2xvdw==');
    expect(await closed).toBe(1006);
    await vi.waitFor(() =>
      expect(pty.unsubscribeFromAgent).toHaveBeenCalledWith('slow-agent', slowOutput),
    );
    const received = new Promise<string>((resolve) =>
      healthy.once('message', (raw) => resolve(String(raw))),
    );
    healthyOutput('b2s=');
    expect(JSON.parse(await received)).toEqual({
      type: 'output',
      agentId: 'healthy-agent',
      data: 'b2s=',
    });
    expect(healthy.readyState).toBe(WebSocket.OPEN);
    healthy.close();
  });

  it('rejects input with 4003 (pairing required) and never reaches the PTY', async () => {
    const ws = await connectAndAuth(mobileToken);
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: 'input', agentId: 'agent-1', data: 'rm -rf ~' }));
    expect(await closed).toBe(4003);
    expect(pty.writeToAgent).not.toHaveBeenCalled();
  });

  it('rejects resize with 4003 and does not resize the PTY', async () => {
    const ws = await connectAndAuth(mobileToken);
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: 'resize', agentId: 'agent-1', cols: 80, rows: 24 }));
    expect(await closed).toBe(4003);
    expect(pty.resizeAgent).not.toHaveBeenCalled();
  });

  it('rejects view-size with 4003 and leaves the PTY size alone', async () => {
    const ws = await connectAndAuth(mobileToken);
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: 'view-size', agentId: 'agent-1', cols: 60, rows: 50 }));
    expect(await closed).toBe(4003);
    expect(pty.setAgentRemoteSize).not.toHaveBeenCalled();
  });

  it('rejects kill with 4003 and does not kill the agent', async () => {
    const ws = await connectAndAuth(mobileToken);
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: 'kill', agentId: 'agent-1' }));
    expect(await closed).toBe(4003);
    expect(pty.killAgent).not.toHaveBeenCalled();
  });
});

describe('subscribe snapshot', () => {
  it('sends the rendered snapshot when the PTY has one', async () => {
    vi.mocked(pty.subscribeToAgentRendered).mockImplementation((_id, onSnapshot) => {
      onSnapshot({ data: 'cmVuZGVyZWQ=', cols: 60, rows: 50 });
      return vi.fn();
    });
    const ws = await connectAndAuth(mobileToken);
    const scrollback = new Promise<unknown>((resolve) =>
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === 'scrollback') resolve(msg);
      }),
    );
    ws.send(JSON.stringify({ type: 'subscribe', agentId: 'agent-1' }));
    expect(await scrollback).toEqual({
      type: 'scrollback',
      agentId: 'agent-1',
      data: 'cmVuZGVyZWQ=',
      cols: 60,
      rows: 50,
    });
    expect(pty.getAgentScrollback).not.toHaveBeenCalled();
    ws.close();
  });
});

describe('paired phone view size', () => {
  it('sizes the PTY and hands it back when the phone disconnects', async () => {
    const ws = await connectAndAuth(await pair());
    ws.send(JSON.stringify({ type: 'view-size', agentId: 'agent-1', cols: 60, rows: 50 }));
    await vi.waitFor(() =>
      expect(pty.setAgentRemoteSize).toHaveBeenCalledWith('agent-1', { cols: 60, rows: 50 }),
    );
    ws.close();
    await vi.waitFor(() => expect(pty.setAgentRemoteSize).toHaveBeenCalledWith('agent-1', null));
  });

  it('hands the size back on an explicit release', async () => {
    const ws = await connectAndAuth(await pair());
    ws.send(JSON.stringify({ type: 'view-size', agentId: 'agent-1', cols: 60, rows: 50 }));
    ws.send(JSON.stringify({ type: 'view-size', agentId: 'agent-1' }));
    await vi.waitFor(() => expect(pty.setAgentRemoteSize).toHaveBeenCalledWith('agent-1', null));
    ws.close();
  });

  it('ignores a release from a phone that does not own the size', async () => {
    const owner = await connectAndAuth(await pair());
    const other = await connectAndAuth(await pair());
    owner.send(JSON.stringify({ type: 'view-size', agentId: 'agent-1', cols: 60, rows: 50 }));
    await vi.waitFor(() => expect(pty.setAgentRemoteSize).toHaveBeenCalledTimes(1));
    other.send(JSON.stringify({ type: 'view-size', agentId: 'agent-1' }));
    other.close();
    // Give the ignored release a chance to arrive before checking.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pty.setAgentRemoteSize).toHaveBeenCalledTimes(1);
    owner.close();
  });
});

describe('paired token over WebSocket', () => {
  it('forwards input to the agent PTY', async () => {
    const ws = await connectAndAuth(await pair());
    ws.send(JSON.stringify({ type: 'input', agentId: 'agent-1', data: 'hi' }));
    await vi.waitFor(() => {
      expect(pty.writeToAgent).toHaveBeenCalledWith('agent-1', 'hi');
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('silently drops oversized input (>4096 chars) without closing', async () => {
    const ws = await connectAndAuth(await pair());
    ws.send(JSON.stringify({ type: 'input', agentId: 'agent-1', data: 'x'.repeat(4097) }));
    // Probe with a valid message to ensure the oversized one was processed first
    ws.send(JSON.stringify({ type: 'input', agentId: 'agent-1', data: 'ok' }));
    await vi.waitFor(() => {
      expect(pty.writeToAgent).toHaveBeenCalledWith('agent-1', 'ok');
    });
    expect(pty.writeToAgent).not.toHaveBeenCalledWith('agent-1', 'x'.repeat(4097));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('still cannot resize or kill (4003)', async () => {
    const paired = await pair();
    const ws1 = await connectAndAuth(paired);
    const closed1 = waitForClose(ws1);
    ws1.send(JSON.stringify({ type: 'resize', agentId: 'agent-1', cols: 80, rows: 24 }));
    expect(await closed1).toBe(4003);

    const ws2 = await connectAndAuth(paired);
    const closed2 = waitForClose(ws2);
    ws2.send(JSON.stringify({ type: 'kill', agentId: 'agent-1' }));
    expect(await closed2).toBe(4003);

    expect(pty.resizeAgent).not.toHaveBeenCalled();
    expect(pty.killAgent).not.toHaveBeenCalled();
  });

  it('disconnects a paired phone that is already connected when devices are forgotten', async () => {
    const paired = await pair();
    const ws = await connectAndAuth(paired);
    const closed = waitForClose(ws);
    srv.forgetRememberedDevices();
    // A socket authenticates once, on its auth message. Revoking the token alone would leave
    // this one streaming every agent's output and still allowed to send input.
    await closed;
  });

  it('a paired token from a stopped server is refused (4001)', async () => {
    const paired = await pair();
    await stop();
    const srv = await startRemoteServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: '/nonexistent',
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
      getCoordinator: () => null,
    });
    port = srv.port;
    stop = srv.stop;
    await expect(connectAndAuth(paired)).rejects.toThrow('4001');
  });
});

describe('browser Origin on the WebSocket upgrade', () => {
  /** Attempt an upgrade with the given headers; resolves with the HTTP status when refused. */
  function upgradeStatus(headers: Record<string, string>): Promise<number | 'open'> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
        ws.terminate();
      });
      ws.on('open', () => {
        resolve('open');
        ws.close();
      });
      ws.on('error', (err) => {
        // ws also emits 'error' after 'unexpected-response'; only surface it
        // when nothing else resolved first.
        reject(err);
      });
    });
  }

  it('refuses an Origin that does not match the Host (403)', async () => {
    expect(await upgradeStatus({ Origin: 'http://evil.example' })).toBe(403);
  });

  it('refuses an opaque "null" Origin (403)', async () => {
    expect(await upgradeStatus({ Origin: 'null' })).toBe(403);
  });

  it('accepts the origin this server itself serves', async () => {
    expect(await upgradeStatus({ Origin: `http://127.0.0.1:${port}` })).toBe('open');
  });

  it('accepts non-browser clients that send no Origin', async () => {
    expect(await upgradeStatus({})).toBe('open');
  });

  it('a cross-origin page with a valid token still cannot type', async () => {
    await expect(connectAndAuth(await pair(), { Origin: 'http://evil.example' })).rejects.toThrow();
    expect(pty.writeToAgent).not.toHaveBeenCalled();
  });
});

describe('browser Origin on HTTP API routes', () => {
  it('refuses a cross-origin fetch even with a valid token (403)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents`, {
      headers: { Authorization: `Bearer ${coordinatorToken}`, Origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('serves a same-origin fetch', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents`, {
      headers: {
        Authorization: `Bearer ${coordinatorToken}`,
        Origin: `http://127.0.0.1:${port}`,
      },
    });
    expect(res.status).toBe(200);
  });
});

describe('isBrowserOriginAllowed', () => {
  it('allows requests without an Origin (non-browser clients)', () => {
    expect(isBrowserOriginAllowed({ host: '10.0.0.2:7777' })).toBe(true);
  });

  it('requires the Origin host to equal the Host header, case-insensitively', () => {
    expect(isBrowserOriginAllowed({ host: '10.0.0.2:7777', origin: 'http://10.0.0.2:7777' })).toBe(
      true,
    );
    expect(
      isBrowserOriginAllowed({ host: 'Desktop.local:7777', origin: 'http://desktop.local:7777' }),
    ).toBe(true);
    expect(isBrowserOriginAllowed({ host: '10.0.0.2:7777', origin: 'http://10.0.0.2:7778' })).toBe(
      false,
    );
    expect(isBrowserOriginAllowed({ host: '10.0.0.2:7777', origin: 'http://attacker.test' })).toBe(
      false,
    );
  });

  it('refuses opaque, malformed, and non-http origins', () => {
    expect(isBrowserOriginAllowed({ host: 'a:1', origin: 'null' })).toBe(false);
    expect(isBrowserOriginAllowed({ host: 'a:1', origin: 'not a url' })).toBe(false);
    expect(isBrowserOriginAllowed({ host: 'a:1', origin: 'file://a:1' })).toBe(false);
    // Node joins duplicate Origin headers with ", " — not a URL, so refused.
    expect(isBrowserOriginAllowed({ host: 'a:1', origin: 'http://a:1, http://b:1' })).toBe(false);
  });

  it('refuses an Origin when the request carries no Host', () => {
    expect(isBrowserOriginAllowed({ origin: 'http://a:1' })).toBe(false);
  });
});

describe('buildRemoteCsp', () => {
  it('pins scripts to the bundle and the socket to the requested host', () => {
    const csp = buildRemoteCsp('10.0.0.2:7777');
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("connect-src 'self' ws://10.0.0.2:7777 wss://10.0.0.2:7777");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-eval');
  });

  it('drops a Host that could inject directives', () => {
    const csp = buildRemoteCsp("x; script-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self';");
    expect(csp).not.toContain('x; script-src');
    expect(buildRemoteCsp(undefined)).toContain("connect-src 'self';");
  });
});

describe('mobile SPA static responses', () => {
  const html = '<!doctype html><title>Phone app</title>';
  const javascript = 'document.body.textContent = "Phone app";';
  let staticDir = '';

  beforeEach(async () => {
    await stop();
    staticDir = mkdtempSync(join(tmpdir(), 'pc-remote-static-'));
    writeFileSync(join(staticDir, 'index.html'), html);
    mkdirSync(join(staticDir, 'assets'));
    writeFileSync(join(staticDir, 'assets', 'index-test.js'), javascript);
    const srv = await startRemoteServer({
      port: 0,
      host: '127.0.0.1',
      staticDir,
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
      getCoordinator: () => null,
    });
    port = srv.port;
    stop = async () => {
      await srv.stop();
      rmSync(staticDir, { recursive: true, force: true });
    };
  });

  it.each(['/', '/index.html', '/task'])('serves HTML with its CSP at %s', async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(buildRemoteCsp(`127.0.0.1:${port}`));
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe(html);
  });

  it('serves the JavaScript body with immutable caching', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets/index-test.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(await res.text()).toBe(javascript);
  });

  it.each(['/assets', '/assets/'])(
    'serves the app, not an error, for the directory %s',
    async (path) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(html);
    },
  );

  it('returns 404 for a missing asset instead of the app page', async () => {
    // An old hashed bundle requested after an update must fail as a script, not load HTML.
    const res = await fetch(`http://127.0.0.1:${port}/assets/index-old.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('Not found');
  });

  it.skipIf(process.getuid?.() === 0)(
    'returns an uncached error when an existing file cannot be read',
    async () => {
      chmodSync(join(staticDir, 'assets', 'index-test.js'), 0o000);
      const res = await fetch(`http://127.0.0.1:${port}/assets/index-test.js`);
      expect(res.status).toBe(500);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await res.text()).toContain('Unable to load the phone app.');
    },
  );
});

describe('unauthenticated WebSocket clients', () => {
  function connectRaw(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  it('closes 4001 when input is sent before auth, without reaching the PTY', async () => {
    const ws = await connectRaw();
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: 'input', agentId: 'agent-1', data: 'hi' }));
    expect(await closed).toBe(4001);
    expect(pty.writeToAgent).not.toHaveBeenCalled();
  });

  it('closes 4001 on auth with an unknown token', async () => {
    const ws = await connectRaw();
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: 'auth', token: 'not-a-real-token' }));
    expect(await closed).toBe(4001);
  });
});

describe('coordinator token over WebSocket', () => {
  it('forwards input to the agent PTY', async () => {
    const ws = await connectAndAuth(coordinatorToken);
    ws.send(JSON.stringify({ type: 'input', agentId: 'agent-1', data: 'hello' }));
    await vi.waitFor(() => {
      expect(pty.writeToAgent).toHaveBeenCalledWith('agent-1', 'hello');
    });
    ws.close();
  });
});

describe('acknowledged phone messages', () => {
  function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(String(raw)))));
  }

  it('acknowledges only after both pasted text and Enter reach the PTY', async () => {
    const ws = await connectAndAuth(await pair());
    const result = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'input',
        agentId: 'agent-1',
        data: 'hello\nworld',
        requestId: 'reply-1',
        submit: true,
      }),
    );
    expect(await result).toEqual({ type: 'input-result', requestId: 'reply-1', ok: true });
    expect(pty.writeToAgent).toHaveBeenNthCalledWith(1, 'agent-1', 'hello\nworld');
    expect(pty.writeToAgent).toHaveBeenNthCalledWith(2, 'agent-1', '\r');
    ws.close();
  });

  it('reports a missing agent instead of claiming delivery', async () => {
    vi.mocked(pty.writeToAgent).mockImplementationOnce(() => {
      throw new Error('Agent not found');
    });
    const ws = await connectAndAuth(await pair());
    const result = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'input',
        agentId: 'gone',
        data: 'hello',
        requestId: 'reply-2',
        submit: true,
      }),
    );
    expect(await result).toMatchObject({ type: 'input-result', requestId: 'reply-2', ok: false });
    expect(pty.writeToAgent).toHaveBeenCalledTimes(1);
    ws.close();
  });

  it('reports a partial submission if the agent exits before Enter', async () => {
    vi.mocked(pty.writeToAgent)
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('gone');
      });
    const ws = await connectAndAuth(await pair());
    const result = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'input',
        agentId: 'gone',
        data: 'hello',
        requestId: 'reply-3',
        submit: true,
      }),
    );
    expect(await result).toMatchObject({
      ok: false,
      error: expect.stringContaining('Check the terminal'),
    });
    ws.close();
  });

  it('does not interleave two phones submitting into the same prompt', async () => {
    const ws1 = await connectAndAuth(await pair());
    const ws2 = await connectAndAuth(await pair());
    const accepted = nextMessage(ws1);
    const rejected = nextMessage(ws2);
    const text = 'line\n'.repeat(40);
    ws1.send(
      JSON.stringify({
        type: 'input',
        agentId: 'agent-1',
        data: text,
        requestId: 'first',
        submit: true,
      }),
    );
    await vi.waitFor(() => expect(pty.writeToAgent).toHaveBeenCalledWith('agent-1', text));
    ws2.send(
      JSON.stringify({
        type: 'input',
        agentId: 'agent-1',
        data: 'second',
        requestId: 'second',
        submit: true,
      }),
    );
    expect(await rejected).toMatchObject({ requestId: 'second', ok: false });
    expect(await accepted).toMatchObject({ requestId: 'first', ok: true });
    expect(pty.writeToAgent).not.toHaveBeenCalledWith('agent-1', 'second');
    ws1.close();
    ws2.close();
  });

  it('types a shell prefix in its own write so the TUI reads it as a keystroke', async () => {
    const ws = await connectAndAuth(await pair());
    const result = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'input',
        agentId: 'agent-1',
        data: 'ls -la',
        requestId: 'shell-1',
        submit: true,
        prefixKey: '!',
      }),
    );
    expect(await result).toEqual({ type: 'input-result', requestId: 'shell-1', ok: true });
    expect(pty.writeToAgent).toHaveBeenNthCalledWith(1, 'agent-1', '!');
    expect(pty.writeToAgent).toHaveBeenNthCalledWith(2, 'agent-1', 'ls -la');
    expect(pty.writeToAgent).toHaveBeenNthCalledWith(3, 'agent-1', '\r');
    ws.close();
  });

  it('does not let a second phone type into the shell prompt a prefix just opened', async () => {
    const ws1 = await connectAndAuth(await pair());
    const ws2 = await connectAndAuth(await pair());
    const rejected = nextMessage(ws2);
    ws1.send(
      JSON.stringify({
        type: 'input',
        agentId: 'agent-1',
        data: 'ls -la',
        requestId: 'shell',
        submit: true,
        prefixKey: '!',
      }),
    );
    await vi.waitFor(() => expect(pty.writeToAgent).toHaveBeenCalledWith('agent-1', '!'));
    ws2.send(
      JSON.stringify({
        type: 'input',
        agentId: 'agent-1',
        data: 'Looks good, ship it',
        requestId: 'chat',
        submit: true,
      }),
    );
    expect(await rejected).toMatchObject({ requestId: 'chat', ok: false });
    expect(pty.writeToAgent).not.toHaveBeenCalledWith('agent-1', 'Looks good, ship it');
    ws1.close();
    ws2.close();
  });

  it('does not give view-only phones write access through acknowledged submission', async () => {
    const ws = await connectAndAuth(mobileToken);
    const closed = waitForClose(ws);
    ws.send(
      JSON.stringify({
        type: 'input',
        agentId: 'agent-1',
        data: 'hello',
        requestId: 'no-access',
        submit: true,
      }),
    );
    expect(await closed).toBe(4003);
    expect(pty.writeToAgent).not.toHaveBeenCalled();
  });
});

describe('rebind', () => {
  it('completes while a WebSocket client is connected and keeps serving HTTP', async () => {
    const ws = await connectAndAuth(mobileToken);
    const closed = waitForClose(ws);
    await rebind('127.0.0.1');
    expect(typeof (await closed)).toBe('number');
    const res = await fetch(`http://127.0.0.1:${port}/api/pair/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mobileToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '000000' }),
    });
    expect(res.status).not.toBe(404);
  });
});

describe('rebind', () => {
  /** Fail the next listen the way a missing interface does, without touching the network. */
  const failListen = function (this: http.Server) {
    process.nextTick(() => this.emit('error', new Error('EADDRNOTAVAIL')));
    return this;
  };

  it('restores the previous interface when the new one cannot be bound', async () => {
    // A wildcard bind blocks every other listener on the port, so narrow first; the
    // second loopback address can then be occupied (Linux) or is missing (macOS): a
    // real bind failure either way.
    await rebind('127.0.0.1');
    const occupied = http.createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', (error: NodeJS.ErrnoException) =>
        error.code === 'EADDRNOTAVAIL' ? resolve() : reject(error),
      );
      occupied.listen(port, '127.0.0.2', resolve);
    });
    try {
      await expect(rebind('127.0.0.2')).rejects.toThrow(/EADDRINUSE|EADDRNOTAVAIL/);
    } finally {
      if (occupied.listening) await new Promise((resolve) => occupied.close(resolve));
    }
    expect(srv.bindHost).toBe('127.0.0.1');
    expect(srv.listening).toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}/api/pair/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mobileToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '000000' }),
    });
    expect(res.status).not.toBe(404);
    const ws = await connectAndAuth(mobileToken);
    ws.close();
  });

  // The fallback re-listens on the address just released, so nothing real can take it
  // in between; only a stub makes both binds fail.
  it('releases a handle that can listen nowhere so the caller can drop it', async () => {
    const listen = vi.spyOn(http.Server.prototype, 'listen').mockImplementation(failListen);
    try {
      await expect(rebind('127.0.0.1')).rejects.toThrow('EADDRNOTAVAIL');
    } finally {
      listen.mockRestore();
    }
    expect(srv.listening).toBe(false);
    await expect(connectAndAuth(mobileToken)).rejects.toThrow();
    // The stop path releases PTY subscriptions; a second stop from afterEach is harmless.
    for (const subscription of vi.mocked(pty.onPtyEvent).mock.results)
      expect(subscription.value).toHaveBeenCalled();
  });
});
