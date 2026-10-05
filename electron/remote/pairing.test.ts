// Tests for device pairing + paired-mobile task-creation routes in the remote
// HTTP server. Verifies the read-only mobile token cannot create tasks, that a
// correct PIN elevates it to a paired token, and the attempt/expiry limits hold.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../ipc/pty.js', () => ({
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(),
  subscribeToAgentRendered: vi.fn(() => null),
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => []),
  getAgentMeta: vi.fn(() => null),
  getAgentCols: vi.fn(() => 80),
  getAgentRows: vi.fn(() => 24),
  onPtyEvent: vi.fn(() => vi.fn()),
}));

vi.mock('./protocol.js', () => ({
  parseClientMessage: vi.fn(() => null),
}));

/** Lets one test make persisting the credential file fail the way a full disk would. */
const { failAtomicWrite } = vi.hoisted(() => ({ failAtomicWrite: { value: false } }));
vi.mock('../mcp/atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mcp/atomic.js')>();
  return {
    ...actual,
    atomicWriteFileSync: (...args: Parameters<typeof actual.atomicWriteFileSync>) => {
      if (failAtomicWrite.value) throw new Error('ENOSPC: no space left on device');
      return actual.atomicWriteFileSync(...args);
    },
  };
});

const { startRemoteServer, toFriendlyListenError } = await import('./server.js');

type Resp = { status: number; json: () => Promise<unknown> };

let port = 0;
let stop: (forgetDevices?: boolean) => Promise<void>;
let mobileToken = '';
let credentialsDir: string;
let generatePin: () => { pin: string; expiresAt: number };
const createTaskFromMobile = vi.fn(async () => ({ taskId: 'task-123' }));
const getProjects = vi.fn(async () => [{ id: 'proj-1', name: 'Repo One' }]);

function req(method: string, path: string, token: string, body?: unknown): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const r = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({
          status: res.statusCode ?? 0,
          json: () => Promise.resolve(raw ? (JSON.parse(raw) as unknown) : null),
        });
      });
    });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

async function pair(remember = false): Promise<string> {
  const { pin } = generatePin();
  const res = await req('POST', '/api/pair/verify', mobileToken, { pin, remember });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

async function startServer(enableRemembered = true) {
  const srv = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: '/nonexistent',
    getTaskName: (id) => id,
    getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
    getCoordinator: () => null,
    getProjects,
    createTaskFromMobile,
  });
  if (enableRemembered) srv.enableRememberedDevices(join(credentialsDir, 'phones.json'));
  port = srv.port;
  stop = srv.stop;
  mobileToken = srv.mobileToken;
  generatePin = srv.generatePairingPin;
  return srv;
}

beforeEach(async () => {
  createTaskFromMobile.mockClear();
  getProjects.mockClear();
  credentialsDir = mkdtempSync(join(tmpdir(), 'phone-pairing-'));
  await startServer();
});

afterEach(async () => {
  await stop();
  rmSync(credentialsDir, { recursive: true, force: true });
});

describe('remembered phones', () => {
  it('rejects an in-flight pairing body completed during explicit disconnect', async () => {
    const { pin } = generatePin();
    const body = JSON.stringify({ pin, remember: true });
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/pair/verify',
      // A kept-alive socket would hold stop() open until it idles out (~4 s).
      agent: false,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mobileToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Expect: '100-continue',
      },
    });
    const response = new Promise<number>((resolve, reject) => {
      request.on('error', reject);
      request.on('response', (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
    });
    const acceptedHeaders = new Promise<void>((resolve) => request.once('continue', resolve));
    request.flushHeaders();
    await acceptedHeaders;
    request.write(body.slice(0, -1));
    const stopped = stop(true);
    request.end(body.slice(-1));
    expect(await response).toBe(401);
    await stopped;
    expect(JSON.parse(readFileSync(join(credentialsDir, 'phones.json'), 'utf8'))).toEqual([]);
    await startServer();
  });

  it.each(['{broken', '{}', '["invalid-hash"]'])(
    'recovers through fresh pairing when the credential file is invalid: %s',
    async (contents) => {
      const oldToken = await pair(true);
      await stop();
      writeFileSync(join(credentialsDir, 'phones.json'), contents);
      await startServer();
      expect((await req('GET', '/api/mobile/projects', oldToken)).status).toBe(401);
      const newToken = await pair(true);
      await stop();
      await startServer();
      expect((await req('GET', '/api/mobile/projects', newToken)).status).toBe(200);
    },
  );

  it('does not accept remembered phones until remote access is explicitly enabled', async () => {
    const paired = await pair(true);
    await stop();
    const srv = await startServer(false);
    expect((await req('GET', '/api/mobile/projects', paired)).status).toBe(401);
    srv.enableRememberedDevices(join(credentialsDir, 'phones.json'));
    expect((await req('GET', '/api/mobile/projects', paired)).status).toBe(200);
  });

  it('keeps opted-in phones across restarts without persisting bearer tokens', async () => {
    const paired = await pair(true);
    const oldMobile = mobileToken;
    const file = join(credentialsDir, 'phones.json');
    expect(readFileSync(file, 'utf8')).not.toContain(paired);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await stop();
    await startServer();
    expect((await req('GET', '/api/mobile/projects', paired)).status).toBe(200);
    expect((await req('GET', '/api/agents', oldMobile)).status).toBe(401);
    expect((await req('GET', '/api/tasks', paired)).status).toBe(403);
  });

  it('forgets session-only phones on restart', async () => {
    const paired = await pair();
    await stop();
    await startServer();
    expect((await req('GET', '/api/mobile/projects', paired)).status).toBe(401);
  });

  it('revokes remembered phones on explicit disconnect', async () => {
    const paired = await pair(true);
    await stop();
    const srv = await startServer();
    await srv.stop(true);
    await startServer();
    expect((await req('GET', '/api/mobile/projects', paired)).status).toBe(401);
  });

  it('revokes paired phones in the running server, not just the credential file', async () => {
    await stop();
    const srv = await startServer();
    const remembered = await pair(true);
    const sessionOnly = await pair();
    srv.forgetRememberedDevices();
    expect((await req('GET', '/api/mobile/projects', remembered)).status).toBe(401);
    expect((await req('GET', '/api/mobile/projects', sessionOnly)).status).toBe(401);
    // Re-enabling the same credential file must not resurrect the revoked phones.
    srv.enableRememberedDevices(join(credentialsDir, 'phones.json'));
    expect((await req('GET', '/api/mobile/projects', remembered)).status).toBe(401);
    expect((await req('GET', '/api/mobile/projects', sessionOnly)).status).toBe(401);
  });

  it('revokes remembered phones durably even when the credential file cannot be rewritten', async () => {
    const remembered = await pair(true);
    const credentials = join(credentialsDir, 'phones.json');
    expect(JSON.parse(readFileSync(credentials, 'utf8'))).toHaveLength(1);
    // Revoking in memory is not enough: the next start reads the file back, so a rewrite that
    // fails must leave no file rather than one still naming the phone we just revoked.
    failAtomicWrite.value = true;
    try {
      await stop(true);
    } finally {
      failAtomicWrite.value = false;
    }
    expect(existsSync(credentials)).toBe(false);
    await startServer();
    expect((await req('GET', '/api/mobile/projects', remembered)).status).toBe(401);
  });

  it('evicts the oldest remembered phone when the credential limit is reached', async () => {
    const oldest = await pair(true);
    for (let i = 0; i < 8; i++) await pair(true);
    await stop();
    await startServer();
    expect((await req('GET', '/api/mobile/projects', oldest)).status).toBe(401);
  });
});

describe('pairing', () => {
  it('elevates the mobile token to a paired token with the correct PIN', async () => {
    const paired = await pair();
    expect(typeof paired).toBe('string');
    expect(paired).not.toBe(mobileToken);
  });

  it('rejects an incorrect PIN', async () => {
    generatePin();
    const res = await req('POST', '/api/pair/verify', mobileToken, { pin: '000000' });
    // A random wrong guess; if it happened to match, the test PIN space is 1e6.
    expect([401]).toContain(res.status);
  });

  it('rejects a non-6-digit PIN with 400', async () => {
    generatePin();
    const res = await req('POST', '/api/pair/verify', mobileToken, { pin: '12' });
    expect(res.status).toBe(400);
  });

  it('locks out after too many wrong attempts', async () => {
    const { pin } = generatePin();
    const wrong = pin === '999999' ? '888888' : '999999';
    for (let i = 0; i < 5; i++) {
      const r = await req('POST', '/api/pair/verify', mobileToken, { pin: wrong });
      expect(r.status).toBe(401);
    }
    // PIN is now invalidated even though we submit the correct value.
    const afterLock = await req('POST', '/api/pair/verify', mobileToken, { pin });
    expect(afterLock.status).toBe(401);
  });

  it('returns 401 when no PIN has been generated', async () => {
    const res = await req('POST', '/api/pair/verify', mobileToken, { pin: '123456' });
    expect(res.status).toBe(401);
  });
});

describe('paired-mobile routes', () => {
  it('mobile token cannot list projects or create tasks (403)', async () => {
    expect((await req('GET', '/api/mobile/projects', mobileToken)).status).toBe(403);
    expect(
      (
        await req('POST', '/api/mobile/tasks', mobileToken, {
          projectId: 'p',
          name: 'n',
          prompt: 'x',
        })
      ).status,
    ).toBe(403);
  });

  it('paired token can list projects', async () => {
    const paired = await pair();
    const res = await req('GET', '/api/mobile/projects', paired);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'proj-1', name: 'Repo One' }]);
  });

  it('paired token can create a task', async () => {
    const paired = await pair();
    const res = await req('POST', '/api/mobile/tasks', paired, {
      projectId: 'proj-1',
      name: 'Fix bug',
      prompt: 'Investigate the crash',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ taskId: 'task-123' });
    expect(createTaskFromMobile).toHaveBeenCalledWith({
      projectId: 'proj-1',
      name: 'Fix bug',
      prompt: 'Investigate the crash',
    });
  });

  it('rejects task creation with a missing name or prompt', async () => {
    const paired = await pair();
    expect(
      (await req('POST', '/api/mobile/tasks', paired, { projectId: 'proj-1', prompt: 'x' })).status,
    ).toBe(400);
    expect(
      (await req('POST', '/api/mobile/tasks', paired, { projectId: 'proj-1', name: 'n' })).status,
    ).toBe(400);
    expect(
      (await req('POST', '/api/mobile/tasks', paired, { name: 'n', prompt: 'x' })).status,
    ).toBe(400);
    expect(createTaskFromMobile).not.toHaveBeenCalled();
  });

  it('paired token still has read-only agent access', async () => {
    const paired = await pair();
    expect((await req('GET', '/api/agents', paired)).status).toBe(200);
  });

  it('rejects unauthenticated access', async () => {
    expect((await req('GET', '/api/mobile/projects', 'bogus-token')).status).toBe(401);
  });
});

describe('toFriendlyListenError', () => {
  it('rewrites EADDRINUSE to an actionable message but keeps the code for retry', () => {
    const raw = Object.assign(new Error('listen EADDRINUSE: address already in use 0.0.0.0:7777'), {
      code: 'EADDRINUSE',
    }) as NodeJS.ErrnoException;
    const friendly = toFriendlyListenError(raw, 7777);
    expect(friendly.code).toBe('EADDRINUSE'); // retry loop still detects it
    expect(friendly.message).toMatch(/already in use/i);
    expect(friendly.message).toContain('7777');
  });

  it('passes other errors through unchanged', () => {
    const other = Object.assign(new Error('boom'), { code: 'EACCES' }) as NodeJS.ErrnoException;
    expect(toFriendlyListenError(other, 7777)).toBe(other);
  });
});
