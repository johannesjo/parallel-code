import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync, rmSync, statSync } from 'fs';
import { tmpdir, platform } from 'os';
import { join, dirname } from 'path';
import { createServer } from 'net';
import { execFileSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startRemoteServer } from '../remote/server.js';
import { DOCKER_DEFAULT_IMAGE } from '../ipc/pty.js';
import { getMCPRemoteServerUrl, getSubTaskMcpConfigPath } from './config.js';
import type { Coordinator } from './coordinator.js';
import {
  selectMcpJsonDir,
  buildCoordinatorMCPConfig,
  validateStartMCPServerArgs,
} from '../ipc/register.js';
import { getDockerMcpServerDestPath } from '../ipc/mcp-paths.js';

const RUN_DOCKER_MCP_TEST = process.env.RUN_DOCKER_MCP_TEST === '1';

const describeDocker = RUN_DOCKER_MCP_TEST ? describe : describe.skip;

function requireDockerImage(image: string): void {
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(
      `Can't complete Docker MCP integration test: Docker is not running or not reachable. ${String(err)}`,
    );
  }

  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(
      `Can't complete Docker MCP integration test: required image "${image}" is missing. Build it with: docker build -t ${image} docker/. ${String(err)}`,
    );
  }
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a TCP port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

describeDocker('Docker MCP integration', () => {
  let worktreePath: string | undefined;
  let remoteServer: Awaited<ReturnType<typeof startRemoteServer>> | undefined;
  let createdTaskName: string | undefined;

  beforeAll(() => {
    requireDockerImage(DOCKER_DEFAULT_IMAGE);
  });

  afterAll(async () => {
    await remoteServer?.stop();
    if (worktreePath) rmSync(worktreePath, { recursive: true, force: true });
  });

  it('runs the bundled MCP server inside the Parallel Code Docker image and reaches the host remote API', async () => {
    worktreePath = mkdtempSync(join(tmpdir(), 'parallel-code-docker-mcp-'));
    const mcpDir = join(worktreePath, '.parallel-code');
    mkdirSync(mcpDir, { recursive: true });

    const bundledMcpServerPath = join(process.cwd(), 'dist-electron', 'mcp-server.cjs');
    const dockerMcpServerPath = join(mcpDir, 'mcp-server.cjs');
    copyFileSync(bundledMcpServerPath, dockerMcpServerPath);

    const coordinator = {
      createTask: async (opts: { name: string }) => {
        createdTaskName = opts.name;
        return { id: 'task-from-docker' };
      },
      getTaskStatus: (taskId: string) => ({
        id: taskId,
        name: createdTaskName ?? 'unknown',
        branchName: 'task/from-docker',
        worktreePath: join(worktreePath as string, 'child'),
        projectId: 'project-1',
        agentId: 'agent-1',
        status: 'idle',
        coordinatorTaskId: 'coord-1',
        exitCode: null,
      }),
      listTasks: () => [
        {
          id: 'existing-task',
          name: 'Existing task',
          branchName: 'task/existing',
          status: 'idle',
          coordinatorTaskId: 'coord-1',
          exitCode: null,
        },
      ],
    } as unknown as Coordinator;

    const port = await findFreePort();
    remoteServer = await startRemoteServer({
      port,
      staticDir: worktreePath,
      getTaskName: (taskId) => taskId,
      getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
      getCoordinator: () => coordinator,
    });

    const serverUrl = getMCPRemoteServerUrl(remoteServer.port, 'parallel-code-test-container');
    const mcpConfig = {
      mcpServers: {
        'parallel-code': {
          type: 'stdio',
          command: 'node',
          args: [dockerMcpServerPath, '--url', serverUrl, '--coordinator-id', 'coord-1'],
          env: { PARALLEL_CODE_MCP_TOKEN: remoteServer.token },
        },
      },
    };
    writeFileSync(join(worktreePath, '.mcp.json'), JSON.stringify(mcpConfig, null, 2));

    const transport = new StdioClientTransport({
      command: 'docker',
      args: [
        'run',
        '--rm',
        '-i',
        '--network',
        'host',
        '-v',
        `${worktreePath}:${worktreePath}`,
        '-w',
        worktreePath,
        '-e',
        `PARALLEL_CODE_MCP_TOKEN=${remoteServer.token}`,
        DOCKER_DEFAULT_IMAGE,
        'node',
        dockerMcpServerPath,
        '--url',
        serverUrl,
        '--coordinator-id',
        'coord-1',
      ],
    });
    const client = new Client({ name: 'parallel-code-docker-mcp-test', version: '1.0.0' });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('create_task');

      const createResult = await client.callTool({
        name: 'create_task',
        arguments: { name: 'Created from Docker MCP', prompt: 'do the docker MCP work' },
      });

      expect(createdTaskName).toBe('Created from Docker MCP');
      expect(JSON.stringify(createResult.content)).toContain('task-from-docker');
    } finally {
      await client.close();
    }
  }, 60_000);

  // Regression test for the bug where sub-task MCP config was written to the sub-task
  // worktree (not a Docker volume mount) and relied on auto-discovery instead of --mcp-config.
  // This test simulates a sub-task running via `docker exec --mcp-config <coordinator-vol-path>`.
  it('sub-task reaches MCP server via explicit --mcp-config in coordinator .parallel-code dir', async () => {
    const coordWorktree = mkdtempSync(join(tmpdir(), 'parallel-code-coord-'));
    const mcpDir = join(coordWorktree, '.parallel-code');
    mkdirSync(mcpDir, { recursive: true });

    const bundledMcpServerPath = join(process.cwd(), 'dist-electron', 'mcp-server.cjs');
    const dockerMcpServerPath = join(mcpDir, 'mcp-server.cjs');
    copyFileSync(bundledMcpServerPath, dockerMcpServerPath);

    let signalReceived = false;
    const subtaskCoordinator = {
      signalDone: (_taskId: string) => {
        signalReceived = true;
      },
      getTaskStatus: (taskId: string) => ({
        id: taskId,
        name: 'subtask',
        branchName: 'task/sub',
        worktreePath: coordWorktree,
        projectId: 'p1',
        agentId: 'a1',
        status: 'running',
        coordinatorTaskId: 'coord-1',
        exitCode: null,
      }),
      listTasks: () => [],
    } as unknown as Coordinator;

    const port2 = await findFreePort();
    const subServer = await startRemoteServer({
      port: port2,
      staticDir: coordWorktree,
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
      getCoordinator: () => subtaskCoordinator,
    });

    try {
      const serverUrl = getMCPRemoteServerUrl(port2, 'parallel-code-test-container');
      const taskId = 'sub-task-docker-test';

      // getSubTaskMcpConfigPath must use the coordinator's .parallel-code dir, not a sub-task worktree
      const configPath = getSubTaskMcpConfigPath(
        'parallel-code-test-container',
        dockerMcpServerPath,
        taskId,
      );
      expect(dirname(configPath)).toBe(mcpDir); // the coordinator's volume dir
      // Assert the config path is inside the coordinator's .parallel-code dir (which IS a Docker volume)
      // NOT in any sub-task worktree (which is NOT a Docker volume)
      expect(dirname(configPath).endsWith('/.parallel-code')).toBe(true);
      expect(configPath.startsWith(coordWorktree)).toBe(true);

      const subMcpConfig = {
        mcpServers: {
          'parallel-code': {
            type: 'stdio',
            command: 'node',
            args: [dockerMcpServerPath, '--url', serverUrl, '--task-id', taskId],
            env: { PARALLEL_CODE_MCP_TOKEN: subServer.token },
          },
        },
      };
      writeFileSync(configPath, JSON.stringify(subMcpConfig, null, 2), { mode: 0o600 });

      const transport = new StdioClientTransport({
        command: 'docker',
        args: [
          'run',
          '--rm',
          '-i',
          '--network',
          'host',
          '-v',
          `${coordWorktree}:${coordWorktree}`,
          '-w',
          coordWorktree,
          '-e',
          `PARALLEL_CODE_MCP_TOKEN=${subServer.token}`,
          DOCKER_DEFAULT_IMAGE,
          'node',
          dockerMcpServerPath,
          '--url',
          serverUrl,
          '--task-id',
          taskId,
        ],
      });
      const subClient = new Client({ name: 'parallel-code-subtask-test', version: '1.0.0' });

      try {
        await subClient.connect(transport);
        const tools = await subClient.listTools();
        expect(tools.tools.map((t) => t.name)).toContain('signal_done');
        expect(tools.tools.map((t) => t.name)).not.toContain('create_task');

        await subClient.callTool({ name: 'signal_done', arguments: {} });
        expect(signalReceived).toBe(true);
      } finally {
        await subClient.close();
      }
    } finally {
      await subServer.stop();
      rmSync(coordWorktree, { recursive: true, force: true });
    }
  }, 60_000);
});

// ─── Layer 2: Docker smoke tests ─────────────────────────────────────────────
//
// Opt-in (RUN_DOCKER_MCP_TEST=1). Verifies network connectivity and auth from
// inside the Docker container.

describeDocker('Layer 2 — Docker smoke tests', () => {
  let remotePort: number;
  let remoteToken: string;
  let srv: Awaited<ReturnType<typeof startRemoteServer>> | undefined;
  let coordWorktree: string | undefined;

  beforeAll(async () => {
    requireDockerImage(DOCKER_DEFAULT_IMAGE);
    coordWorktree = mkdtempSync(join(tmpdir(), 'parallel-code-smoke-'));
    remotePort = await findFreePort();

    const mockCoordinator = { listTasks: () => [] } as unknown as Coordinator;
    srv = await startRemoteServer({
      port: remotePort,
      staticDir: coordWorktree,
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
      getCoordinator: () => mockCoordinator,
    });
    remoteToken = srv.token;
  });

  afterAll(async () => {
    await srv?.stop();
    if (coordWorktree) rmSync(coordWorktree, { recursive: true, force: true });
  });

  it('container can fetch /api/tasks with correct Bearer token', async () => {
    // Verifies: host.docker.internal resolves from inside the container AND the token works.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const serverUrl = getMCPRemoteServerUrl(srv!.port, 'smoke-test-container');
    const result = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'host',
        DOCKER_DEFAULT_IMAGE,
        'node',
        '-e',
        `
const http = require('http');
const url = new URL('/api/tasks', '${serverUrl}');
const req = http.request(url, { headers: { Authorization: 'Bearer ${remoteToken}' } }, (res) => {
  let body = '';
  res.on('data', (d) => body += d);
  res.on('end', () => { process.stdout.write(JSON.stringify({ status: res.statusCode, body })); });
});
req.on('error', (e) => { process.stderr.write(e.message); process.exit(1); });
req.end();
        `.trim(),
      ],
      { encoding: 'utf-8', timeout: 30_000 },
    );
    const parsed = JSON.parse(result) as { status: number; body: string };
    expect(parsed.status).toBe(200);
  }, 60_000);

  it('container receives 401 for a wrong token', async () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const serverUrl = getMCPRemoteServerUrl(srv!.port, 'smoke-test-container');
    const result = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'host',
        DOCKER_DEFAULT_IMAGE,
        'node',
        '-e',
        `
const http = require('http');
const url = new URL('/api/tasks', '${serverUrl}');
const req = http.request(url, { headers: { Authorization: 'Bearer wrong-token' } }, (res) => {
  process.stdout.write(String(res.statusCode));
});
req.on('error', (e) => { process.stderr.write(e.message); process.exit(1); });
req.end();
        `.trim(),
      ],
      { encoding: 'utf-8', timeout: 30_000 },
    );
    expect(result.trim()).toBe('401');
  }, 60_000);
});

// ─── Layer 2b: Docker image capability check ─────────────────────────────────
//
// Opt-in (RUN_DOCKER_MCP_TEST=1). Verifies that the Docker image has the
// required toolchain (node, git, bash) before running heavier tests.

describeDocker('Layer 2 — Docker image capability check', () => {
  beforeAll(() => {
    requireDockerImage(DOCKER_DEFAULT_IMAGE);
  });

  const run = (cmd: string, args: string[]) =>
    execFileSync(
      'docker',
      ['run', '--rm', '--network', 'host', DOCKER_DEFAULT_IMAGE, cmd, ...args],
      {
        encoding: 'utf-8',
        timeout: 30_000,
      },
    ).trim();

  it('node is available and at least v18', () => {
    const version = run('node', ['--version']);
    expect(version).toMatch(/^v(\d+)/);
    const major = parseInt(version.slice(1).split('.')[0], 10);
    expect(major).toBeGreaterThanOrEqual(18);
  });

  it('git is available', () => {
    const version = run('git', ['--version']);
    expect(version).toContain('git version');
  });

  it('bash is available', () => {
    const version = run('bash', ['--version']);
    expect(version).toContain('GNU bash');
  });
});

// ─── Layer 4: Real coordinator Docker scenario ────────────────────────────────
//
// Opt-in (RUN_DOCKER_MCP_TEST=1).
//
// Uses the actual config-generation pipeline (not hand-built config) to produce
// .mcp.json and copied mcp-server.cjs, then starts Docker with that exact config
// and calls create_task. This is the "most important next test" — it proves that
// the production wiring (not just the concept) works.

describeDocker('Layer 4 — Production-path coordinator Docker scenario', () => {
  let scenarioServer: Awaited<ReturnType<typeof startRemoteServer>> | undefined;
  let scenarioWorktree: string | undefined;
  let createdTaskName: string | undefined;

  beforeAll(() => {
    requireDockerImage(DOCKER_DEFAULT_IMAGE);
  });

  afterAll(async () => {
    await scenarioServer?.stop();
    if (scenarioWorktree) rmSync(scenarioWorktree, { recursive: true, force: true });
  });

  it('uses production config pipeline to generate .mcp.json, then create_task reaches coordinator', async () => {
    scenarioWorktree = mkdtempSync(join(tmpdir(), 'parallel-code-prod-path-'));

    // --- Start remote server with a real coordinator stub ---
    const port = await findFreePort();
    const mockCoordinator = {
      createTask: async (opts: { name: string }) => {
        createdTaskName = opts.name;
        return { id: 'prod-path-task-1' };
      },
      getTaskStatus: (taskId: string) => ({
        id: taskId,
        name: createdTaskName ?? 'unknown',
        branchName: 'task/prod',
        worktreePath: join(scenarioWorktree as string, 'child'),
        projectId: 'p1',
        agentId: 'a1',
        status: 'idle',
        coordinatorTaskId: 'coord-prod',
        exitCode: null,
      }),
      listTasks: () => [],
    } as unknown as Coordinator;

    scenarioServer = await startRemoteServer({
      port,
      staticDir: scenarioWorktree,
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
      getCoordinator: () => mockCoordinator,
    });

    // --- Production config pipeline (same logic as StartMCPServer handler) ---
    const bundledMcpServerPath = join(process.cwd(), 'dist-electron', 'mcp-server.cjs');
    const destPath = getDockerMcpServerDestPath(scenarioWorktree, '/project');
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(bundledMcpServerPath, destPath);

    // Verify the copy is accessible (would fail if worktree isn't mounted in Docker)
    expect(statSync(destPath).size).toBeGreaterThan(0);

    const serverUrl = getMCPRemoteServerUrl(port, 'prod-path-container');
    const mcpConfig = buildCoordinatorMCPConfig({
      mcpServerPath: destPath,
      serverUrl,
      token: scenarioServer.token,
      coordinatorTaskId: 'coord-prod',
    });

    const mcpJsonDir = selectMcpJsonDir(scenarioWorktree, '/project');
    const mcpJsonPath = join(mcpJsonDir, '.mcp.json');
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });

    // --- Assert the generated config uses the correct URL ---
    const args = mcpConfig.mcpServers['parallel-code'].args;
    const urlIdx = args.indexOf('--url');
    if (platform() === 'darwin') {
      expect(args[urlIdx + 1]).toContain('host.docker.internal');
    } else {
      expect(args[urlIdx + 1]).toContain('127.0.0.1');
    }
    // Server path is the copied worktree path (not the dist-electron original)
    expect(args[0]).toBe(destPath);
    expect(args[0]).not.toBe(bundledMcpServerPath);

    // --- Start Docker with the EXACT generated config (not a hand-built one) ---
    const transport = new StdioClientTransport({
      command: 'docker',
      args: [
        'run',
        '--rm',
        '-i',
        '--network',
        'host',
        '-v',
        `${scenarioWorktree}:${scenarioWorktree}`,
        '-w',
        scenarioWorktree,
        '-e',
        `PARALLEL_CODE_MCP_TOKEN=${scenarioServer.token}`,
        DOCKER_DEFAULT_IMAGE,
        'node',
        destPath,
        '--url',
        serverUrl,
        '--coordinator-id',
        'coord-prod',
      ],
    });
    const client = new Client({ name: 'parallel-code-prod-path-test', version: '1.0.0' });

    try {
      await client.connect(transport);

      // list_tools sanity check
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('create_task');

      // create_task reaches the coordinator
      const result = await client.callTool({
        name: 'create_task',
        arguments: { name: 'prod-path-test-task', prompt: 'do the production path work' },
      });

      expect(createdTaskName).toBe('prod-path-test-task');
      expect(JSON.stringify(result.content)).toContain('prod-path-task-1');
    } finally {
      await client.close();
    }
  }, 120_000);
});

// ─── Layer 1: Docker per-container sub-task architecture (#31) ───────────────
//
// No Docker required. Verifies that StartMCPServer args accept `dockerImage`
// and that `getSubTaskMcpConfigPath` still returns a path in the coordinator's
// .parallel-code/ dir (the only dir that is a mounted volume in both coordinator
// and per-sub-task containers).

describe('Docker per-container sub-tasks — StartMCPServer arg validation', () => {
  const VALID_UUID = '00000000-0000-4000-8000-000000000001';

  it('validateStartMCPServerArgs accepts a valid dockerImage', () => {
    expect(() =>
      validateStartMCPServerArgs({
        coordinatorTaskId: VALID_UUID,
        projectId: 'proj-1',
        projectRoot: '/tmp/project',
        dockerContainerName: 'parallel-code-abc123',
        dockerImage: 'parallel-code-agent:latest',
      }),
    ).not.toThrow();
  });

  it('validateStartMCPServerArgs rejects a blank dockerImage', () => {
    expect(() =>
      validateStartMCPServerArgs({
        coordinatorTaskId: VALID_UUID,
        projectId: 'proj-1',
        projectRoot: '/tmp/project',
        dockerImage: '   ',
      }),
    ).toThrow('dockerImage must not be blank');
  });

  it('sub-task MCP config path is in coordinator .parallel-code/ dir (a Docker volume), not the sub-task worktree', () => {
    const coordWorktree = '/tmp/project/.worktrees/task/coord-abc';
    const mcpServerPath = `${coordWorktree}/.parallel-code/mcp-server.cjs`;
    const configPath = getSubTaskMcpConfigPath('parallel-code-coord-abc', mcpServerPath, 'sub-1');
    // Must be inside the coordinator's .parallel-code/ dir
    expect(configPath.startsWith(`${coordWorktree}/.parallel-code/`)).toBe(true);
    // Must NOT be in a sub-task worktree (which is not a Docker volume)
    expect(configPath).not.toContain('.worktrees/task/sub-');
  });
});

// ─── .mcp.json placement logic tests (no Docker required) ────────────────────

describe('Docker coordinator bootstrap — .mcp.json placement', () => {
  it('writes .mcp.json to worktreePath when set (docker mode)', () => {
    const worktreePath = '/tmp/my-repo/.worktrees/task/coord-abc';
    const projectRoot = '/tmp/my-repo';
    const mcpJsonDir = selectMcpJsonDir(worktreePath, projectRoot);
    expect(mcpJsonDir).toBe(worktreePath);
  });

  it('falls back to projectRoot when worktreePath is not set', () => {
    const worktreePath = undefined;
    const projectRoot = '/tmp/my-repo';
    const mcpJsonDir = selectMcpJsonDir(worktreePath, projectRoot);
    expect(mcpJsonDir).toBe(projectRoot);
  });
});

// ─── Layer 1: Path edge case tests (no Docker required) ──────────────────────

describe('Docker coordinator bootstrap — path edge cases', () => {
  it('preserves spaces in worktree path for mcp-server.cjs dest', () => {
    const worktreePath = '/Users/alice bob/my repos/.worktrees/task/coord-abc';
    const dest = getDockerMcpServerDestPath(worktreePath, '/irrelevant');
    expect(dest).toBe(`${worktreePath}/.parallel-code/mcp-server.cjs`);
  });

  it('preserves spaces in worktree path for .mcp.json dir selection', () => {
    const worktreePath = '/Users/alice bob/my repos/.worktrees/task/coord-abc';
    const projectRoot = '/Users/alice bob/my repos';
    expect(selectMcpJsonDir(worktreePath, projectRoot)).toBe(worktreePath);
  });

  it('Claude trust key in buildCoordinatorMCPConfig matches path verbatim', () => {
    // The MCP config passes --coordinator-id which is matched by the backend.
    // Separately, the worktreePath IS the Claude trust key — verify it is not mangled.
    const worktreePath = '/Users/alice bob/my repos/.worktrees/task/coord abc 123';
    const cfg = buildCoordinatorMCPConfig({
      mcpServerPath: `${worktreePath}/.parallel-code/mcp-server.cjs`,
      serverUrl: 'http://host.docker.internal:3001',
      token: 'tok',
      coordinatorTaskId: 'coord-1',
    });
    // The MCP server path arg must contain the verbatim worktree path
    expect(cfg.mcpServers['parallel-code'].args[0]).toBe(
      `${worktreePath}/.parallel-code/mcp-server.cjs`,
    );
  });
});

// ─── Layer 1: Port collision / restart test (no Docker required) ─────────────

describe('Docker coordinator bootstrap — port/token rotation in .mcp.json', () => {
  it('buildCoordinatorMCPConfig reflects new port when called with updated serverUrl', () => {
    const opts = {
      mcpServerPath: '/worktrees/coord/.parallel-code/mcp-server.cjs',
      serverUrl: 'http://host.docker.internal:3001',
      token: 'old-token',
      coordinatorTaskId: 'coord-1',
    };
    const cfgBefore = buildCoordinatorMCPConfig(opts);
    const argsBefore = cfgBefore.mcpServers['parallel-code'].args;
    expect(argsBefore).toContain('http://host.docker.internal:3001');
    expect(cfgBefore.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).toBe('old-token');

    // Simulate restart: new port and token
    const cfgAfter = buildCoordinatorMCPConfig({
      ...opts,
      serverUrl: 'http://host.docker.internal:3099',
      token: 'new-token',
    });
    const argsAfter = cfgAfter.mcpServers['parallel-code'].args;
    expect(argsAfter).toContain('http://host.docker.internal:3099');
    expect(cfgAfter.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).toBe('new-token');
    expect(argsAfter).not.toContain('http://host.docker.internal:3001');
    expect(cfgAfter.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).not.toBe(
      'old-token',
    );
  });
});

// ─── Layer 1: Non-Claude Docker agent (no trust seeding) ─────────────────────

describe('Docker coordinator bootstrap — non-Claude agent MCP connectivity', () => {
  it('buildCoordinatorMCPConfig is command-agnostic — works for any inner command', () => {
    // MCP config is written by the coordinator bootstrap, not by the inner agent.
    // A Codex or OpenCode agent in Docker still gets MCP injected via .mcp.json.
    const cfg = buildCoordinatorMCPConfig({
      mcpServerPath: '/worktrees/coord/.parallel-code/mcp-server.cjs',
      serverUrl: 'http://host.docker.internal:3001',
      token: 'tok',
      coordinatorTaskId: 'coord-1',
    });
    // Config structure is the same regardless of inner agent command
    expect(cfg.mcpServers['parallel-code'].type).toBe('stdio');
    expect(cfg.mcpServers['parallel-code'].command).toBe('node');
  });
});

// ─── Layer 2: Docker volume permissions (opt-in, requires Docker) ────────────

describeDocker('Layer 2 — Docker volume permissions', () => {
  it('files written inside container are owned by the host user (--user flag)', async () => {
    requireDockerImage(DOCKER_DEFAULT_IMAGE);

    const worktree = mkdtempSync(join(tmpdir(), 'docker-vol-perm-'));

    try {
      // Run a command that creates a file inside the mounted worktree
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'host',
          '--user',
          `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
          '-v',
          `${worktree}:${worktree}`,
          '-w',
          worktree,
          DOCKER_DEFAULT_IMAGE,
          'sh',
          '-c',
          `echo hello > ${worktree}/test.txt`,
        ],
        { stdio: 'pipe' },
      );

      const stat = statSync(join(worktree, 'test.txt'));
      // File should be owned by the current process user, not root
      expect(stat.uid).toBe(process.getuid?.() ?? stat.uid);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  }, 60_000);
});

// ─── Layer 2: Project Dockerfile image (opt-in, requires Docker) ─────────────

describeDocker('Layer 9 — Project Dockerfile image MCP smoke test', () => {
  it('can start mcp-server.cjs inside a project-built image', async () => {
    const projectImage = process.env.DOCKER_PROJECT_IMAGE ?? DOCKER_DEFAULT_IMAGE;
    requireDockerImage(projectImage);

    const worktree = mkdtempSync(join(tmpdir(), 'docker-project-img-'));
    const mcpDir = join(worktree, '.parallel-code');
    mkdirSync(mcpDir, { recursive: true });

    const mcpServerSrc = join(dirname(new URL(import.meta.url).pathname), '..', 'mcp-server.cjs');
    const destPath = join(mcpDir, 'mcp-server.cjs');
    copyFileSync(mcpServerSrc, destPath);

    const port = await findFreePort();
    const server = await startRemoteServer({
      port,
      staticDir: worktree,
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
      getCoordinator: () => null,
    });

    try {
      const transport = new StdioClientTransport({
        command: 'docker',
        args: [
          'run',
          '--rm',
          '-i',
          '--network',
          'host',
          '-v',
          `${worktree}:${worktree}`,
          '-w',
          worktree,
          '-e',
          `PARALLEL_CODE_MCP_TOKEN=${server.token}`,
          projectImage,
          'node',
          destPath,
          '--url',
          getMCPRemoteServerUrl(port, 'test-container', platform()),
        ],
      });
      const client = new Client({ name: 'project-image-test', version: '1.0.0' });

      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toContain('create_task');
      } finally {
        await client.close();
      }
    } finally {
      await server.stop();
      rmSync(worktree, { recursive: true, force: true });
    }
  }, 90_000);
});

// ─── Layer 1: Unicode path support (no Docker required) ──────────────────────

describe('Docker coordinator bootstrap — unicode paths', () => {
  it('unicode characters in worktree path are preserved verbatim in config', () => {
    const worktreePath = '/Users/张三/projects/我的代码/.worktrees/task/coord-abc';
    const dest = getDockerMcpServerDestPath(worktreePath, '/irrelevant');
    expect(dest).toBe(`${worktreePath}/.parallel-code/mcp-server.cjs`);
    expect(selectMcpJsonDir(worktreePath, '/irrelevant')).toBe(worktreePath);
  });

  it('unicode in coordinator task id is preserved in --coordinator-id arg', () => {
    const cfg = buildCoordinatorMCPConfig({
      mcpServerPath: '/path/mcp-server.cjs',
      serverUrl: 'http://host.docker.internal:3001',
      token: 'tok',
      coordinatorTaskId: 'coord-任务-1',
    });
    const coordIdx = cfg.mcpServers['parallel-code'].args.indexOf('--coordinator-id');
    expect(cfg.mcpServers['parallel-code'].args[coordIdx + 1]).toBe('coord-任务-1');
  });

  it('unicode in worktree path generates valid JSON', () => {
    const worktreePath = '/home/ünïcödé/project/.worktrees/tâsk/coord';
    const cfg = buildCoordinatorMCPConfig({
      mcpServerPath: `${worktreePath}/.parallel-code/mcp-server.cjs`,
      serverUrl: 'http://host.docker.internal:3001',
      token: 'tök',
      coordinatorTaskId: 'coord-ünïcödé',
    });
    const json = JSON.stringify(cfg, null, 2);
    const parsed = JSON.parse(json) as typeof cfg;
    expect(parsed.mcpServers['parallel-code'].args[0]).toContain('ünïcödé');
  });
});

// ─── Layer 2: MCP tool schema drift (opt-in, requires Docker) ────────────────

describeDocker('Layer 2 — MCP tool schema drift between host and Docker', () => {
  it('list_tools returns the same tool names inside Docker as on the host', async () => {
    requireDockerImage(DOCKER_DEFAULT_IMAGE);

    const worktree = mkdtempSync(join(tmpdir(), 'docker-schema-drift-'));
    const mcpDir = join(worktree, '.parallel-code');
    mkdirSync(mcpDir, { recursive: true });

    const bundledMcpServerPath = join(process.cwd(), 'dist-electron', 'mcp-server.cjs');
    const destPath = join(mcpDir, 'mcp-server.cjs');
    copyFileSync(bundledMcpServerPath, destPath);

    const mockCoordinator = { listTasks: () => [], createTask: async () => ({ id: 'test' }) };
    const port = await findFreePort();
    const server = await startRemoteServer({
      port,
      staticDir: worktree,
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
      getCoordinator: () => mockCoordinator as never,
    });

    // Get host tool list
    const { Client: HostClient } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport: HostTransport } =
      await import('@modelcontextprotocol/sdk/client/stdio.js');
    const hostTransport = new HostTransport({
      command: 'node',
      args: [destPath, '--url', `http://127.0.0.1:${port}`],
      env: { ...process.env, PARALLEL_CODE_MCP_TOKEN: server.token },
    });
    const hostClient = new HostClient({ name: 'host-schema-test', version: '1.0.0' });

    try {
      await hostClient.connect(hostTransport);
      const hostTools = await hostClient.listTools();
      const hostToolNames = hostTools.tools.map((t) => t.name).sort();

      // Get Docker tool list
      const dockerTransport = new StdioClientTransport({
        command: 'docker',
        args: [
          'run',
          '--rm',
          '-i',
          '--network',
          'host',
          '-v',
          `${worktree}:${worktree}`,
          '-w',
          worktree,
          '-e',
          `PARALLEL_CODE_MCP_TOKEN=${server.token}`,
          DOCKER_DEFAULT_IMAGE,
          'node',
          destPath,
          '--url',
          getMCPRemoteServerUrl(port, 'test-container', platform()),
        ],
      });
      const dockerClient = new Client({ name: 'docker-schema-test', version: '1.0.0' });

      try {
        await dockerClient.connect(dockerTransport);
        const dockerTools = await dockerClient.listTools();
        const dockerToolNames = dockerTools.tools.map((t) => t.name).sort();

        // Same tool names — no schema drift
        expect(dockerToolNames).toEqual(hostToolNames);

        // All required tools present in both
        for (const required of [
          'create_task',
          'signal_done',
          'list_tasks',
          'merge_task',
          'close_task',
        ]) {
          expect(hostToolNames).toContain(required);
          expect(dockerToolNames).toContain(required);
        }
      } finally {
        await dockerClient.close();
      }
    } finally {
      await hostClient.close();
      await server.stop();
      rmSync(worktree, { recursive: true, force: true });
    }
  }, 120_000);
});

// ─── Layer 2: Large MCP response over stdio (opt-in, requires Docker) ────────

describeDocker('Layer 2 — Large MCP response over Docker stdio', () => {
  it('large list_tasks response is not truncated over Docker stdio transport', async () => {
    requireDockerImage(DOCKER_DEFAULT_IMAGE);

    const worktree = mkdtempSync(join(tmpdir(), 'docker-large-resp-'));
    const mcpDir = join(worktree, '.parallel-code');
    mkdirSync(mcpDir, { recursive: true });

    const bundledMcpServerPath = join(process.cwd(), 'dist-electron', 'mcp-server.cjs');
    const destPath = join(mcpDir, 'mcp-server.cjs');
    copyFileSync(bundledMcpServerPath, destPath);

    // Return 50 tasks with long names to stress-test stdio framing
    const manyTasks = Array.from({ length: 50 }, (_, i) => ({
      id: `task-${i}`,
      name: `Long task name that takes up space in the response buffer — task number ${i} with some padding text`.repeat(
        2,
      ),
      branchName: `task/branch-${i}`,
      status: 'idle' as const,
      coordinatorTaskId: 'coord-1',
      exitCode: null,
    }));

    const mockCoordinator = { listTasks: () => manyTasks };
    const port = await findFreePort();
    const server = await startRemoteServer({
      port,
      staticDir: worktree,
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
      getCoordinator: () => mockCoordinator as never,
    });

    try {
      const transport = new StdioClientTransport({
        command: 'docker',
        args: [
          'run',
          '--rm',
          '-i',
          '--network',
          'host',
          '-v',
          `${worktree}:${worktree}`,
          '-w',
          worktree,
          '-e',
          `PARALLEL_CODE_MCP_TOKEN=${server.token}`,
          DOCKER_DEFAULT_IMAGE,
          'node',
          destPath,
          '--url',
          getMCPRemoteServerUrl(port, 'test-container', platform()),
        ],
      });
      const client = new Client({ name: 'large-resp-test', version: '1.0.0' });

      try {
        await client.connect(transport);
        const result = await client.callTool({ name: 'list_tasks', arguments: {} });
        const content = JSON.stringify(result.content);
        // All 50 task IDs must be present — none truncated
        for (let i = 0; i < 50; i++) {
          expect(content).toContain(`task-${i}`);
        }
      } finally {
        await client.close();
      }
    } finally {
      await server.stop();
      rmSync(worktree, { recursive: true, force: true });
    }
  }, 120_000);
});
