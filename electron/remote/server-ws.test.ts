// WebSocket-level access control for the remote server.
// The QR-code (mobile) token only watches: it can subscribe to output but
// must not type, resize, or kill. Typing needs the paired token (PIN entered
// on the phone); resize and kill stay coordinator-only. Browser pages from
// any other origin are refused at the upgrade, before any token is seen.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../ipc/pty.js', () => ({
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(),
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => []),
  getAgentMeta: vi.fn(() => null),
  getAgentCols: vi.fn(() => 80),
  onPtyEvent: vi.fn(() => vi.fn()), // returns an unsubscribe fn
}));

const pty = await import('../ipc/pty.js');
const { startRemoteServer, isBrowserOriginAllowed, buildRemoteCsp } = await import('./server.js');

let port = 0;
let coordinatorToken = '';
let mobileToken = '';
let generatePin: () => { pin: string; expiresAt: number };
let stop: () => Promise<void>;

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
  const srv = await startRemoteServer({
    port: 0,
    host: '0.0.0.0',
    staticDir: '/nonexistent',
    getTaskName: (id) => id,
    getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
    getCoordinator: () => null,
  });
  port = srv.port;
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

  it('rejects kill with 4003 and does not kill the agent', async () => {
    const ws = await connectAndAuth(mobileToken);
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: 'kill', agentId: 'agent-1' }));
    expect(await closed).toBe(4003);
    expect(pty.killAgent).not.toHaveBeenCalled();
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

  it('is sent with the mobile SPA static responses', async () => {
    await stop();
    const staticDir = mkdtempSync(join(tmpdir(), 'pc-remote-static-'));
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>x</title>');
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
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(buildRemoteCsp(`127.0.0.1:${port}`));
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
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
