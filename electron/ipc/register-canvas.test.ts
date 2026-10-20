import type { BrowserWindow } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { registerAllHandlers } from './register.js';
import { IPC } from './channels.js';
import { startRemoteServer } from '../remote/server.js';
import * as remote from '../remote/server.js';
import * as chats from '../chat/sessions.js';
import * as git from './git.js';
import * as tasks from './tasks.js';
import { DelegationService } from '../mcp/delegation.js';
import type { ParallelCodeMcpConfig } from '../mcp/agent-args.js';

const { handlers, spawnAgent, onPtyEvent, getAgentMeta, writeToAgent } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: Record<string, unknown>) => unknown>(),
  spawnAgent: vi.fn(),
  writeToAgent: vi.fn(),
  getAgentMeta: vi.fn<
    () => { taskId: string; agentId: string; isShell: boolean; canvasTools: boolean } | null
  >(() => null),
  onPtyEvent: vi.fn((_event: string, _listener: (agentId: string) => void) => vi.fn()),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, args: Record<string, unknown>) => unknown,
    ) => handlers.set(channel, handler),
  },
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  dialog: {},
  shell: {},
  clipboard: {},
  BrowserWindow: {},
  Notification: {},
}));
vi.mock('./pty.js', async (original) => ({
  ...(await original<typeof import('./pty.js')>()),
  spawnAgent,
  writeToAgent,
  getAgentMeta,
  onPtyEvent,
  // Chat startup resolves its command in PATH; CI has no agent CLI installed.
  validateCommand: vi.fn(),
}));
vi.mock('./plans.js', async (original) => ({
  ...(await original<typeof import('./plans.js')>()),
  ensurePlansDirectory: vi.fn(),
  startPlanWatcher: vi.fn(),
}));

afterEach(async () => {
  await handlers.get(IPC.StopRemoteServer)?.(undefined, {});
  handlers.clear();
  vi.clearAllMocks();
  getAgentMeta.mockReturnValue(null);
  vi.restoreAllMocks();
  for (const agent of ['startup-test-agent', 'cleanup-test-agent'])
    fs.rmSync(path.join(os.tmpdir(), `parallel-code-canvas-${agent}.json`), { force: true });
  // Docker sessions write into the task mount, which is the temp directory here.
  for (const file of ['parallel-code-canvas-docker-test-agent.json', 'canvas-mcp-server.cjs'])
    fs.rmSync(path.join(os.tmpdir(), '.parallel-code', file), { force: true });
});

/** Source-mode tests lack the packaged bundle that Docker sessions copy into the worktree. */
function mockCanvasBundle() {
  const readFileSync = fs.readFileSync;
  vi.spyOn(fs, 'accessSync').mockImplementation(() => {});
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file, options) =>
    String(file).endsWith('mcp-server.cjs')
      ? '// bundle'
      : readFileSync(file, options)) as typeof fs.readFileSync);
}

it('gives chat a separate canvas token and config and removes both on close', async () => {
  mockCanvasBundle();
  getAgentMeta.mockReturnValue(null);
  const win = {
    on: vi.fn(),
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
  registerAllHandlers(win);
  const register = vi.fn(() => 'chat-secret');
  const unregister = vi.fn();
  const server = {
    port: 7777,
    registerCanvasAgent: register,
    unregisterCanvasAgent: unregister,
    getSessionAgents: () => [],
    hasCanvasAgents: () => false,
    stop: vi.fn(async () => {}),
  } as unknown as Awaited<ReturnType<typeof startRemoteServer>>;
  vi.spyOn(remote, 'startRemoteServer').mockResolvedValueOnce(server);
  let resource: { args: string[]; dispose: () => void } | undefined;
  vi.spyOn(chats, 'startAgentChat').mockImplementation(async (_opts, _publish, prepare) => {
    resource = await prepare?.();
    return { canvasTools: !!resource };
  });
  try {
    const result = await handlers.get(IPC.AgentChat)?.(undefined, {
      action: 'start',
      provider: 'claude',
      command: 'claude',
      taskId: 'task',
      agentId: 'terminal-agent',
      cwd: os.tmpdir(),
      channelId: '12345678-1234-4234-8234-123456789012',
    });
    expect(result).toEqual({ canvasTools: true });
    expect(register).toHaveBeenCalledWith(
      'task',
      expect.not.stringMatching(/^terminal-agent$/),
      expect.any(Function),
    );
    expect(resource?.args[0]).toBe('--mcp-config');
    const configPath = resource?.args[1] ?? '';
    expect(fs.readFileSync(configPath, 'utf8')).toContain('chat-secret');
    resource?.dispose();
    expect(unregister).toHaveBeenCalledOnce();
    expect(fs.existsSync(configPath)).toBe(false);
  } finally {
    resource?.dispose();
  }
});

it.each(['transport', 'configuration'])(
  'starts the normal agent unchanged after a canvas %s failure',
  async (failure) => {
    const win = {
      on: vi.fn(),
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    } as unknown as BrowserWindow;
    registerAllHandlers(win);
    const server = {
      port: 7777,
      registerCanvasAgent: vi.fn(() => 'test-secret'),
      unregisterCanvasAgent: vi.fn(),
      getSessionAgents: () => [],
      hasCanvasAgents: () => false,
      stop: vi.fn(async () => {}),
    } as unknown as Awaited<ReturnType<typeof startRemoteServer>>;
    const start = vi.spyOn(remote, 'startRemoteServer');
    if (failure === 'transport') start.mockRejectedValueOnce(new Error('Transport unavailable'));
    else {
      start.mockResolvedValueOnce(server);
      vi.spyOn(fs, 'accessSync').mockImplementationOnce(() => {
        throw new Error('Bundle unavailable');
      });
    }
    const args = {
      command: 'codex',
      args: ['--resume', 'session'],
      taskId: 'task',
      agentId: 'agent',
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
      canvasMcp: true,
      env: { KEEP: 'value' },
    };
    expect(await handlers.get(IPC.SpawnAgent)?.(undefined, args)).toEqual({ canvasTools: false });
    expect(spawnAgent).toHaveBeenCalledWith(expect.any(Function), args, expect.any(Function));
    if (failure === 'configuration')
      expect(server.unregisterCanvasAgent).toHaveBeenCalledWith('agent');
  },
);

it.each([
  { command: 'bash', isShell: true, canvasMcp: true, args: [] },
  { command: 'custom-agent', canvasMcp: true, args: [] },
  { command: 'codex', canvasMcp: false, args: ['--config', 'existing=1'] },
  { command: 'claude', canvasMcp: true, args: ['--mcp-config', 'custom.json'] },
])(
  'does not inject canvas settings into explicitly configured or unrelated sessions: %j',
  async (session) => {
    const win = {
      on: vi.fn(),
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    } as unknown as BrowserWindow;
    registerAllHandlers(win);
    const start = vi.spyOn(remote, 'startRemoteServer');
    const args = {
      ...session,
      taskId: 'task',
      agentId: 'agent',
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
    };
    await handlers.get(IPC.SpawnAgent)?.(undefined, args);
    expect(start).not.toHaveBeenCalled();
    expect(spawnAgent).toHaveBeenCalledWith(expect.any(Function), args, expect.any(Function));
  },
);

it('starts an ordinary Codex terminal with canvas MCP when the development port 8777 is occupied', async () => {
  // Source-mode tests do not have the adjacent packaged MCP bundle.
  vi.spyOn(fs, 'accessSync').mockImplementationOnce(() => {});
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once('error', (err: NodeJS.ErrnoException) => {
      // A local app may already hold the port; that also exercises the retry.
      if (err.code === 'EADDRINUSE') resolve();
      else reject(err);
    });
    occupied.listen(8777, '127.0.0.1', resolve);
  });
  try {
    const win = {
      on: vi.fn(),
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    } as unknown as BrowserWindow;
    registerAllHandlers(win);
    const spawn = handlers.get(IPC.SpawnAgent);
    if (!spawn) throw new Error('SpawnAgent handler was not registered');
    const result = await spawn(undefined, {
      command: 'codex',
      args: [],
      taskId: 'startup-test-task',
      agentId: 'startup-test-agent',
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
      canvasMcp: true,
      attachExisting: true,
      onOutput: { __CHANNEL_ID__: 'test-output' },
    });
    expect(result).toEqual({ canvasTools: true });
    expect(spawnAgent).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        canvasTools: true,
        args: ['--config', expect.stringContaining('mcp_servers.parallel-code=')],
      }),
      expect.any(Function),
    );
    const config = JSON.parse(
      fs.readFileSync(
        path.join(os.tmpdir(), 'parallel-code-canvas-startup-test-agent.json'),
        'utf8',
      ),
    ) as ParallelCodeMcpConfig;
    const serverArgs = config.mcpServers['parallel-code'].args;
    expect(new URL(serverArgs[serverArgs.indexOf('--url') + 1]).port).not.toBe('8777');
    // Every failed listen must detach its PTY listeners before retrying.
    // The first subscription belongs to registerAllHandlers (credential cleanup) and stays.
    expect(onPtyEvent.mock.results.length).toBeGreaterThanOrEqual(7);
    for (const subscription of onPtyEvent.mock.results.slice(1, -3))
      expect(subscription.value).toHaveBeenCalledOnce();
  } finally {
    if (occupied.listening) await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

it('rejects a listen failure and releases subscriptions instead of leaving startup pending', async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    await expect(
      startRemoteServer({
        port: address.port,
        host: '127.0.0.1',
        staticDir: os.tmpdir(),
        getTaskName: (id) => id,
        getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
        getCoordinator: () => null,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(onPtyEvent).toHaveBeenCalledTimes(3);
    for (const subscription of onPtyEvent.mock.results)
      expect(subscription.value).toHaveBeenCalledOnce();
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

it.each([IPC.KillAgent, IPC.KillAllAgents])(
  'cancels pending canvas startup with %s',
  async (kill) => {
    const win = {
      on: vi.fn(),
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    } as unknown as BrowserWindow;
    registerAllHandlers(win);
    const server = {
      port: 7777,
      registerCanvasAgent: vi.fn(),
      unregisterCanvasAgent: vi.fn(),
      getSessionAgents: () => [],
      hasCanvasAgents: () => false,
      stop: vi.fn(async () => {}),
    } as unknown as Awaited<ReturnType<typeof startRemoteServer>>;
    let ready!: (server: Awaited<ReturnType<typeof startRemoteServer>>) => void;
    vi.spyOn(remote, 'startRemoteServer').mockReturnValueOnce(
      new Promise((resolve) => {
        ready = resolve;
      }),
    );
    const result = handlers.get(IPC.SpawnAgent)?.(undefined, {
      command: 'codex',
      args: [],
      taskId: 'task',
      agentId: 'agent',
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
      canvasMcp: true,
    });
    const rejected = expect(result).rejects.toThrow('startup was cancelled');
    await handlers.get(kill)?.(undefined, { agentId: 'agent' });
    ready(server);
    await rejected;
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(server.registerCanvasAgent).not.toHaveBeenCalled();
  },
);

it('preserves the configured capability when reattaching, without reconfiguring the CLI', async () => {
  const win = {
    on: vi.fn(),
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
  registerAllHandlers(win);
  getAgentMeta.mockReturnValue({
    taskId: 'task',
    agentId: 'agent',
    isShell: false,
    canvasTools: true,
  });
  const start = vi.spyOn(remote, 'startRemoteServer');
  const args = {
    command: 'codex',
    args: [],
    taskId: 'task',
    agentId: 'agent',
    cols: 80,
    rows: 24,
    cwd: os.tmpdir(),
    canvasMcp: true,
    attachExisting: true,
  };
  expect(await handlers.get(IPC.SpawnAgent)?.(undefined, args)).toEqual({ canvasTools: true });
  expect(start).not.toHaveBeenCalled();
  expect(spawnAgent).toHaveBeenCalledWith(
    expect.any(Function),
    { ...args, canvasTools: true },
    expect.any(Function),
  );
});

it('deletes the credential file when the agent exits', async () => {
  vi.spyOn(fs, 'accessSync').mockImplementationOnce(() => {});
  const win = {
    on: vi.fn(),
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
  registerAllHandlers(win);
  const server = {
    port: 7777,
    registerCanvasAgent: vi.fn(() => 'test-secret'),
    unregisterCanvasAgent: vi.fn(),
    getSessionAgents: () => [],
    hasCanvasAgents: () => false,
    stop: vi.fn(async () => {}),
  } as unknown as Awaited<ReturnType<typeof startRemoteServer>>;
  vi.spyOn(remote, 'startRemoteServer').mockResolvedValueOnce(server);
  await handlers.get(IPC.SpawnAgent)?.(undefined, {
    command: 'claude',
    args: [],
    taskId: 'cleanup-test-task',
    agentId: 'cleanup-test-agent',
    cols: 80,
    rows: 24,
    cwd: os.tmpdir(),
    canvasMcp: true,
  });
  const configPath = path.join(os.tmpdir(), 'parallel-code-canvas-cleanup-test-agent.json');
  expect(fs.existsSync(configPath)).toBe(true);
  const exit = onPtyEvent.mock.calls.find((call) => call[0] === 'exit')?.[1];
  if (!exit) throw new Error('registerAllHandlers did not subscribe to PTY exit');
  exit('other-agent');
  expect(fs.existsSync(configPath)).toBe(true);
  exit('cleanup-test-agent');
  expect(fs.existsSync(configPath)).toBe(false);
});

it('refuses to narrow the bind while Docker agents on macOS use the canvas', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  mockCanvasBundle();
  const win = {
    on: vi.fn(),
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
  registerAllHandlers(win);
  const server = {
    port: 7777,
    bindHost: '0.0.0.0',
    registerCanvasAgent: vi.fn(() => 'test-secret'),
    unregisterCanvasAgent: vi.fn(),
    getSessionAgents: () => [],
    hasCanvasAgents: () => true,
    forgetRememberedDevices: vi.fn(),
    rebind: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  vi.spyOn(remote, 'startRemoteServer').mockResolvedValueOnce(
    server as unknown as Awaited<ReturnType<typeof startRemoteServer>>,
  );
  try {
    await handlers.get(IPC.SpawnAgent)?.(undefined, {
      command: 'claude',
      args: [],
      taskId: 'docker-test-task',
      agentId: 'docker-test-agent',
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
      canvasMcp: true,
      dockerMode: true,
    });
    expect(await handlers.get(IPC.StopRemoteServer)?.(undefined, {})).toEqual({
      stopped: false,
      reason: 'docker_active',
    });
    expect(server.rebind).not.toHaveBeenCalled();
    expect(server.stop).not.toHaveBeenCalled();
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform);
  }
});

it('ends phone access but keeps the canvas transport on loopback while agents use it', async () => {
  vi.spyOn(fs, 'accessSync').mockImplementationOnce(() => {});
  const win = {
    on: vi.fn(),
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
  registerAllHandlers(win);
  const server = {
    port: 7777,
    bindHost: '0.0.0.0',
    registerCanvasAgent: vi.fn(() => 'test-secret'),
    unregisterCanvasAgent: vi.fn(),
    getSessionAgents: () => [],
    hasCanvasAgents: () => true,
    forgetRememberedDevices: vi.fn(),
    rebind: vi.fn(async (host: string) => {
      server.bindHost = host;
    }),
    stop: vi.fn(async () => {}),
  };
  vi.spyOn(remote, 'startRemoteServer').mockResolvedValueOnce(
    server as unknown as Awaited<ReturnType<typeof startRemoteServer>>,
  );
  await handlers.get(IPC.SpawnAgent)?.(undefined, {
    command: 'claude',
    args: [],
    taskId: 'startup-test-task',
    agentId: 'startup-test-agent',
    cols: 80,
    rows: 24,
    cwd: os.tmpdir(),
    canvasMcp: true,
  });
  expect(await handlers.get(IPC.StopRemoteServer)?.(undefined, {})).toEqual({ stopped: true });
  expect(server.rebind).toHaveBeenCalledWith('127.0.0.1');
  expect(server.forgetRememberedDevices).toHaveBeenCalled();
  expect(server.stop).not.toHaveBeenCalled();
  expect(await handlers.get(IPC.GetRemoteStatus)?.(undefined, {})).toEqual({
    enabled: false,
    connectedClients: 0,
  });
  server.hasCanvasAgents = () => false;
});

/** A running mocked transport as register.ts sees it; `agents` mirrors registered canvas agents. */
function mockServer(overrides: { platform?: string } = {}) {
  const agents = new Set<string>();
  const server = {
    port: 7777,
    bindHost: overrides.platform === 'darwin' ? '0.0.0.0' : '127.0.0.1',
    url: 'http://127.0.0.1:7777?token=mobile',
    wifiUrl: null,
    tailscaleUrl: null,
    listening: true,
    registerCanvasAgent: vi.fn((_taskId: string, agentId: string) => {
      agents.add(agentId);
      return 'test-secret';
    }),
    unregisterCanvasAgent: vi.fn((agentId: string) => {
      agents.delete(agentId);
    }),
    getSessionAgents: () => [],
    hasCanvasAgents: () => agents.size > 0,
    enableRememberedDevices: vi.fn(),
    forgetRememberedDevices: vi.fn(),
    connectedClients: () => 0,
    rebind: vi.fn(async (host: string) => {
      server.bindHost = host;
    }),
    stop: vi.fn(async () => {}),
  };
  return server;
}
const asHandle = (server: ReturnType<typeof mockServer>) =>
  server as unknown as Awaited<ReturnType<typeof startRemoteServer>>;
const canvasSpawn = (agentId: string, extra: Record<string, unknown> = {}) => ({
  command: 'claude',
  args: [],
  taskId: 'task',
  agentId,
  cols: 80,
  rows: 24,
  cwd: os.tmpdir(),
  canvasMcp: true,
  ...extra,
});
const testWindow = () =>
  ({
    on: vi.fn(),
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  }) as unknown as BrowserWindow;
const exitAgent = (agentId: string) => {
  const exit = onPtyEvent.mock.calls.find((call) => call[0] === 'exit')?.[1];
  if (!exit) throw new Error('registerAllHandlers did not subscribe to PTY exit');
  exit(agentId);
};

it('revokes the canvas token and its file when the PTY itself fails to spawn', async () => {
  vi.spyOn(fs, 'accessSync').mockImplementationOnce(() => {});
  registerAllHandlers(testWindow());
  const server = mockServer();
  vi.spyOn(remote, 'startRemoteServer').mockResolvedValueOnce(asHandle(server));
  spawnAgent.mockImplementationOnce(() => {
    throw new Error('posix_spawn failed');
  });
  await expect(
    handlers.get(IPC.SpawnAgent)?.(undefined, canvasSpawn('cleanup-test-agent')),
  ).rejects.toThrow('posix_spawn failed');
  expect(server.unregisterCanvasAgent).toHaveBeenCalledWith('cleanup-test-agent');
  expect(
    fs.existsSync(path.join(os.tmpdir(), 'parallel-code-canvas-cleanup-test-agent.json')),
  ).toBe(false);
});

it('leaves a same-id restart its canvas token when the spawn it replaced is cancelled', async () => {
  vi.spyOn(fs, 'accessSync').mockImplementation(() => {});
  registerAllHandlers(testWindow());
  const server = mockServer();
  vi.spyOn(remote, 'startRemoteServer').mockResolvedValue(asHandle(server));
  let cancelFirst!: (error: Error) => void;
  spawnAgent.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        cancelFirst = reject;
      }),
  );
  const first = handlers.get(IPC.SpawnAgent)?.(undefined, canvasSpawn('cleanup-test-agent'));
  await tick();
  const restart = await handlers.get(IPC.SpawnAgent)?.(
    undefined,
    canvasSpawn('cleanup-test-agent'),
  );
  expect(restart).toEqual({ canvasTools: true });
  cancelFirst(new Error('Agent startup cancelled'));
  await expect(first).rejects.toThrow('Agent startup cancelled');
  // The cancelled spawn owns nothing any more; tearing down would strand the restart
  // with a revoked token and a deleted --mcp-config file.
  expect(server.unregisterCanvasAgent).toHaveBeenCalledTimes(1);
  expect(
    fs.existsSync(path.join(os.tmpdir(), 'parallel-code-canvas-cleanup-test-agent.json')),
  ).toBe(true);
});

it('revokes the canvas token when the user kills an agent mid-spawn', async () => {
  vi.spyOn(fs, 'accessSync').mockImplementation(() => {});
  registerAllHandlers(testWindow());
  const server = mockServer();
  vi.spyOn(remote, 'startRemoteServer').mockResolvedValue(asHandle(server));
  let cancel!: (error: Error) => void;
  spawnAgent.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        cancel = reject;
      }),
  );
  const spawn = handlers.get(IPC.SpawnAgent)?.(undefined, canvasSpawn('cleanup-test-agent'));
  await tick();
  await handlers.get(IPC.KillAgent)?.(undefined, { agentId: 'cleanup-test-agent' });
  cancel(new Error('Agent startup was cancelled.'));
  await expect(spawn).rejects.toThrow('Agent startup was cancelled.');
  // Nobody took the spawn over, and no PTY exists to ever fire an exit, so this is the last
  // chance to revoke. A live token authenticates on its own, with no check that the agent runs.
  expect(server.unregisterCanvasAgent).toHaveBeenCalledWith('cleanup-test-agent');
  expect(
    fs.existsSync(path.join(os.tmpdir(), 'parallel-code-canvas-cleanup-test-agent.json')),
  ).toBe(false);
});

it('shares one listener between a manual start and a canvas spawn that overlap', async () => {
  vi.spyOn(fs, 'accessSync').mockImplementationOnce(() => {});
  registerAllHandlers(testWindow());
  const server = mockServer({ platform: 'darwin' });
  let ready!: (server: Awaited<ReturnType<typeof startRemoteServer>>) => void;
  const start = vi.spyOn(remote, 'startRemoteServer').mockReturnValueOnce(
    new Promise((resolve) => {
      ready = resolve;
    }),
  );
  const manual = handlers.get(IPC.StartRemoteServer)?.(undefined, {});
  const spawn = handlers.get(IPC.SpawnAgent)?.(undefined, canvasSpawn('startup-test-agent'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  ready(asHandle(server));
  expect(await manual).toMatchObject({ port: 7777 });
  expect(await spawn).toEqual({ canvasTools: true });
  expect(start).toHaveBeenCalledTimes(1);
  expect(server.registerCanvasAgent).toHaveBeenCalledWith(
    'task',
    'startup-test-agent',
    undefined,
    undefined,
  );
  expect(server.rebind).not.toHaveBeenCalled();
  expect(await handlers.get(IPC.GetRemoteStatus)?.(undefined, {})).toMatchObject({ enabled: true });
});

it('allows narrowing the bind again once the last macOS Docker agent has exited', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  mockCanvasBundle();
  registerAllHandlers(testWindow());
  const server = mockServer({ platform: 'darwin' });
  vi.spyOn(remote, 'startRemoteServer').mockResolvedValueOnce(asHandle(server));
  try {
    await handlers.get(IPC.SpawnAgent)?.(
      undefined,
      canvasSpawn('docker-test-agent', { dockerMode: true }),
    );
    await handlers.get(IPC.SpawnAgent)?.(undefined, canvasSpawn('startup-test-agent'));
    expect(await handlers.get(IPC.StopRemoteServer)?.(undefined, {})).toEqual({
      stopped: false,
      reason: 'docker_active',
    });
    exitAgent('docker-test-agent');
    expect(await handlers.get(IPC.StopRemoteServer)?.(undefined, {})).toEqual({ stopped: true });
    expect(server.rebind).toHaveBeenCalledWith('127.0.0.1');
    expect(server.stop).not.toHaveBeenCalled();
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform);
  }
});

it('stops a transport started only for the canvas when its last agent exits', async () => {
  vi.spyOn(fs, 'accessSync').mockImplementationOnce(() => {});
  registerAllHandlers(testWindow());
  const server = mockServer();
  vi.spyOn(remote, 'startRemoteServer').mockResolvedValueOnce(asHandle(server));
  await handlers.get(IPC.SpawnAgent)?.(undefined, canvasSpawn('cleanup-test-agent'));
  exitAgent('other-agent');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(server.stop).not.toHaveBeenCalled();
  exitAgent('cleanup-test-agent');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(server.stop).toHaveBeenCalledWith(false);
  expect(await handlers.get(IPC.StopRemoteServer)?.(undefined, {})).toEqual({ stopped: true });
  expect(server.stop).toHaveBeenCalledTimes(1);
});

it('keeps a manually started transport when the last canvas agent exits', async () => {
  vi.spyOn(fs, 'accessSync').mockImplementationOnce(() => {});
  registerAllHandlers(testWindow());
  const server = mockServer({ platform: 'darwin' });
  vi.spyOn(remote, 'startRemoteServer').mockResolvedValueOnce(asHandle(server));
  await handlers.get(IPC.StartRemoteServer)?.(undefined, {});
  await handlers.get(IPC.SpawnAgent)?.(undefined, canvasSpawn('cleanup-test-agent'));
  exitAgent('cleanup-test-agent');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(server.stop).not.toHaveBeenCalled();
  expect(await handlers.get(IPC.GetRemoteStatus)?.(undefined, {})).toMatchObject({ enabled: true });
});

const onDarwin = async (run: () => Promise<void>) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try {
    await run();
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform);
  }
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it('defers the idle stop while a rebind is in flight and gives the spawn a live transport', () =>
  onDarwin(async () => {
    mockCanvasBundle();
    registerAllHandlers(testWindow());
    const loopback = mockServer();
    let finishRebind!: () => void;
    loopback.rebind = vi.fn(
      (host: string) =>
        new Promise<void>((resolve) => {
          finishRebind = () => {
            loopback.bindHost = host;
            resolve();
          };
        }),
    );
    const wide = mockServer({ platform: 'darwin' });
    vi.spyOn(remote, 'startRemoteServer')
      .mockResolvedValueOnce(asHandle(loopback))
      .mockResolvedValueOnce(asHandle(wide));
    await handlers.get(IPC.SpawnAgent)?.(undefined, canvasSpawn('cleanup-test-agent'));
    const docker = handlers.get(IPC.SpawnAgent)?.(
      undefined,
      canvasSpawn('docker-test-agent', { dockerMode: true }),
    );
    await tick();
    expect(loopback.rebind).toHaveBeenCalledWith('0.0.0.0');
    exitAgent('cleanup-test-agent');
    await tick();
    expect(loopback.stop).not.toHaveBeenCalled();
    finishRebind();
    expect(await docker).toEqual({ canvasTools: true });
    // The rebound listener had no user left once the rebind settled; the spawn got a fresh one.
    expect(loopback.stop).toHaveBeenCalledTimes(1);
    expect(wide.registerCanvasAgent).toHaveBeenCalledWith(
      'task',
      'docker-test-agent',
      undefined,
      undefined,
    );
    expect(await handlers.get(IPC.GetRemoteStatus)?.(undefined, {})).toMatchObject({
      enabled: true,
    });
  }));

it('forgets the wide-bind need when a same-id restart replaces a Docker session', () =>
  onDarwin(async () => {
    mockCanvasBundle();
    registerAllHandlers(testWindow());
    const server = mockServer({ platform: 'darwin' });
    vi.spyOn(remote, 'startRemoteServer').mockResolvedValueOnce(asHandle(server));
    await handlers.get(IPC.SpawnAgent)?.(
      undefined,
      canvasSpawn('docker-test-agent', { dockerMode: true }),
    );
    await handlers.get(IPC.SpawnAgent)?.(undefined, canvasSpawn('docker-test-agent'));
    expect(await handlers.get(IPC.StopRemoteServer)?.(undefined, {})).toEqual({ stopped: true });
    expect(server.rebind).toHaveBeenCalledWith('127.0.0.1');
  }));

it('releases a transport started for a spawn that was killed during startup', async () => {
  vi.spyOn(fs, 'accessSync').mockImplementationOnce(() => {});
  registerAllHandlers(testWindow());
  const server = mockServer();
  let ready!: (server: Awaited<ReturnType<typeof startRemoteServer>>) => void;
  vi.spyOn(remote, 'startRemoteServer').mockReturnValueOnce(
    new Promise((resolve) => {
      ready = resolve;
    }),
  );
  const spawn = handlers.get(IPC.SpawnAgent)?.(undefined, canvasSpawn('startup-test-agent'));
  await tick();
  handlers.get(IPC.KillAgent)?.(undefined, { agentId: 'startup-test-agent' });
  ready(asHandle(server));
  await expect(spawn).rejects.toThrow('Agent startup was cancelled.');
  expect(server.registerCanvasAgent).not.toHaveBeenCalled();
  expect(server.stop).toHaveBeenCalledWith(false);
  expect(await handlers.get(IPC.GetRemoteStatus)?.(undefined, {})).toMatchObject({
    enabled: false,
  });
});

it.each([
  { command: 'claude', args: ['--mcp-config', 'custom.json'] },
  { command: 'custom-agent', args: [] },
  { command: 'bash', args: [], isShell: true },
  { command: 'claude', args: [], canvasMcp: false },
])(
  'revokes prior credentials when a replacement cannot receive app-managed tools: %j',
  async (replacement) => {
    mockCanvasBundle();
    registerAllHandlers(testWindow());
    const server = mockServer();
    vi.spyOn(remote, 'startRemoteServer').mockResolvedValueOnce(asHandle(server));
    const agentId = 'cleanup-test-agent';
    await handlers.get(IPC.SpawnAgent)?.(undefined, canvasSpawn(agentId));
    const configPath = path.join(os.tmpdir(), `parallel-code-canvas-${agentId}.json`);
    expect(fs.existsSync(configPath)).toBe(true);
    getAgentMeta.mockReturnValue({ taskId: 'task', agentId, isShell: false, canvasTools: true });
    const before = server.unregisterCanvasAgent.mock.calls.length;
    await handlers.get(IPC.SpawnAgent)?.(undefined, canvasSpawn(agentId, replacement));
    expect(server.unregisterCanvasAgent.mock.calls.length).toBe(before + 1);
    expect(server.registerCanvasAgent).toHaveBeenCalledTimes(1);
    expect(server.hasCanvasAgents()).toBe(false);
    expect(fs.existsSync(configPath)).toBe(false);
  },
);

it('rejects unsafe parent merge cleanup before Git runs, without relying on a renderer task ID', async () => {
  const win = {
    on: vi.fn(),
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
  registerAllHandlers(win);
  const guard = vi
    .spyOn(DelegationService.prototype, 'assertDirectMergeAllowed')
    .mockRejectedValue(
      new Error('Merge first, then close this task to detach its children safely.'),
    );
  const merge = vi.spyOn(git, 'mergeTask');
  await expect(
    handlers.get(IPC.MergeTask)?.(undefined, {
      projectRoot: '/repo',
      branchName: 'task/parent',
      squash: false,
      cleanup: true,
    }),
  ).rejects.toThrow('Merge first, then close this task');
  expect(guard).toHaveBeenCalledWith('/repo', 'task/parent', true);
  expect(merge).not.toHaveBeenCalled();
});

it('blocks automatic renderer writes immediately when orchestration is disabled, preserving manual writes', () => {
  const enabled = vi
    .spyOn(DelegationService.prototype, 'isOrchestrationEnabled')
    .mockReturnValue(false);
  const win = {
    on: vi.fn(),
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
  registerAllHandlers(win);
  const write = handlers.get(IPC.WriteToAgent);
  expect(write).toBeDefined();
  expect(() => write?.(undefined, { agentId: 'agent', data: '\r', automation: true })).toThrow(
    'Agent orchestration is disabled',
  );
  expect(writeToAgent).not.toHaveBeenCalled();
  write?.(undefined, { agentId: 'agent', data: 'Manual prompt' });
  expect(writeToAgent).toHaveBeenCalledWith('agent', 'Manual prompt');
  enabled.mockReturnValue(true);
  write?.(undefined, { agentId: 'agent', data: 'Child update', automation: true });
  expect(writeToAgent).toHaveBeenCalledWith('agent', 'Child update');
});

it('routes deletion of a parent with a pending first child through guarded close', async () => {
  const win = {
    on: vi.fn(),
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
  registerAllHandlers(win);
  vi.spyOn(DelegationService.prototype, 'getTask').mockReturnValue({
    taskId: 'parent',
    name: 'Parent',
    projectId: 'project',
    projectRoot: '/repo',
    worktreePath: '/repo/.worktrees/parent',
    branchName: 'task/parent',
    gitIsolation: 'worktree',
    agentCommand: 'codex',
    agentArgs: [],
    delegationParent: true,
  });
  const close = vi
    .spyOn(DelegationService.prototype, 'closeParent')
    .mockRejectedValue(new Error('A child launch is still settling.'));
  const remove = vi.spyOn(tasks, 'deleteTask');
  await expect(
    handlers.get(IPC.DeleteTask)?.(undefined, {
      taskId: 'parent',
      agentIds: [],
      projectRoot: '/repo',
      branchName: 'task/parent',
      deleteBranch: true,
    }),
  ).rejects.toThrow('still settling');
  expect(close).toHaveBeenCalledWith('parent', true);
  expect(remove).not.toHaveBeenCalled();
});
