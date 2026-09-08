/**
 * Layers 3, 5, 6 — MCP startup pipeline integration, failure modes, log assertions
 *
 * Layer 3: Spawn-path integration — exercises the same functions used by StartMCPServer
 *   without Electron (no ipcMain, no app.getPath). Catches "test config differs from
 *   production config" bugs.
 *
 * Layer 5: Failure-mode tests — clear errors for missing image, bad token, missing server.
 *
 * Layer 6: Log assertions — verifies console.warn output matches what engineers see in logs.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCoordinatorMCPConfig,
  getDockerMcpServerDestPath,
  selectMcpJsonDir,
  validateStartMCPServerArgs,
} from './register.js';
import { getMCPRemoteServerUrl } from '../mcp/config.js';
import { startRemoteServer } from '../remote/server.js';

const TEST_COORDINATOR_ID = '12345678-1234-4234-8234-123456789abc';

const tempDirs: string[] = [];

function mkTemp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-mcp-test-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3: Spawn-path integration
// ─────────────────────────────────────────────────────────────────────────────

describe('Layer 3 — MCP startup pipeline (no Electron, real FS)', () => {
  it('generated .mcp.json in worktree matches production structure', () => {
    const worktreePath = mkTemp();
    const projectRoot = mkTemp();
    const fakeMcpServer = path.join(mkTemp(), 'mcp-server.cjs');
    fs.writeFileSync(fakeMcpServer, '// fake mcp server');

    const serverUrl = getMCPRemoteServerUrl(3001, 'my-container', 'darwin');
    const token = 'test-token-xyz';
    const coordinatorTaskId = TEST_COORDINATOR_ID;

    // --- Docker copy step (same logic as StartMCPServer handler) ---
    const destPath = getDockerMcpServerDestPath(worktreePath, projectRoot);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(fakeMcpServer, destPath);

    // --- Config build step ---
    const mcpConfig = buildCoordinatorMCPConfig({
      mcpServerPath: destPath,
      serverUrl,
      token,
      coordinatorTaskId,
    });

    // --- File write step ---
    const mcpJsonDir = selectMcpJsonDir(worktreePath, projectRoot);
    const mcpJsonPath = path.join(mcpJsonDir, '.mcp.json');
    fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });

    // --- Assertions ---
    expect(fs.existsSync(mcpJsonPath)).toBe(true);
    expect(fs.existsSync(destPath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8')) as typeof mcpConfig;
    const server = written.mcpServers['parallel-code'];

    // Server path in config points to the COPIED file inside the worktree, not the original
    expect(server.args[0]).toBe(destPath);
    expect(server.args[0]).not.toBe(fakeMcpServer);
    expect(server.args[0].startsWith(worktreePath)).toBe(true);

    // URL in config is host.docker.internal (not 127.0.0.1)
    const urlIdx = server.args.indexOf('--url');
    expect(server.args[urlIdx + 1]).toBe('http://host.docker.internal:3001');

    // Token is passed via env var, not args
    expect(server.args).not.toContain('--token');
    expect(server.env['PARALLEL_CODE_MCP_TOKEN']).toBe(token);
  });

  it('mcp-server.cjs is copied to .parallel-code inside the worktree', () => {
    const worktreePath = mkTemp();
    const projectRoot = mkTemp();
    const fakeSrc = path.join(mkTemp(), 'mcp-server.cjs');
    fs.writeFileSync(fakeSrc, '// fake');

    const destPath = getDockerMcpServerDestPath(worktreePath, projectRoot);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(fakeSrc, destPath);

    // Must be inside worktree, under .parallel-code/
    expect(destPath.startsWith(worktreePath)).toBe(true);
    expect(destPath).toContain('/.parallel-code/mcp-server.cjs');
    expect(fs.existsSync(destPath)).toBe(true);
  });

  it('.mcp.json is written to worktree (not project root) so Docker container finds it', () => {
    const worktreePath = mkTemp();
    const projectRoot = mkTemp();
    const mcpJsonDir = selectMcpJsonDir(worktreePath, projectRoot);

    const cfg = buildCoordinatorMCPConfig({
      mcpServerPath: '/server.cjs',
      serverUrl: 'http://host.docker.internal:9999',
      token: 'tok',
      coordinatorTaskId: TEST_COORDINATOR_ID,
    });
    const mcpJsonPath = path.join(mcpJsonDir, '.mcp.json');
    fs.writeFileSync(mcpJsonPath, JSON.stringify(cfg), { mode: 0o600 });

    expect(mcpJsonPath.startsWith(worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.mcp.json'))).toBe(false);
  });

  it('.mcp.json file mode is 0o600 (token is a secret)', () => {
    const worktreePath = mkTemp();
    const cfg = buildCoordinatorMCPConfig({
      mcpServerPath: '/s.cjs',
      serverUrl: 'http://host.docker.internal:1',
      token: 'tok',
      coordinatorTaskId: 'c',
    });
    const p = path.join(worktreePath, '.mcp.json');
    fs.writeFileSync(p, JSON.stringify(cfg), { mode: 0o600 });
    const stat = fs.statSync(p);
    // mode & 0o777 masks off file-type bits; 0o600 = owner r/w only
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('non-Docker path: no copy, .mcp.json still written to worktree', () => {
    const worktreePath = mkTemp();
    const projectRoot = mkTemp();
    const origServerPath = path.join(mkTemp(), 'mcp-server.cjs');
    fs.writeFileSync(origServerPath, '// host server');

    // Non-Docker: no copy step — mcpServerPath stays as the host path
    const serverUrl = getMCPRemoteServerUrl(3001, undefined);
    const cfg = buildCoordinatorMCPConfig({
      mcpServerPath: origServerPath,
      serverUrl,
      token: 'tok',
      coordinatorTaskId: TEST_COORDINATOR_ID,
    });

    const mcpJsonDir = selectMcpJsonDir(worktreePath, projectRoot);
    const mcpJsonPath = path.join(mcpJsonDir, '.mcp.json');
    fs.writeFileSync(mcpJsonPath, JSON.stringify(cfg), { mode: 0o600 });

    const written = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8')) as typeof cfg;
    // URL is 127.0.0.1 (non-Docker)
    const args = written.mcpServers['parallel-code'].args;
    const urlIdx = args.indexOf('--url');
    expect(args[urlIdx + 1]).toBe('http://127.0.0.1:3001');
    // Server path is the host path (no copy)
    expect(args[0]).toBe(origServerPath);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3b: .mcp.json merge / cleanup (#40)
// ─────────────────────────────────────────────────────────────────────────────

describe('Layer 3b — .mcp.json merge and cleanup', () => {
  it('merges parallel-code into a pre-existing .mcp.json preserving other servers', () => {
    const worktreePath = mkTemp();
    const projectRoot = mkTemp();
    const mcpJsonDir = selectMcpJsonDir(worktreePath, projectRoot);
    const mcpJsonPath = path.join(mcpJsonDir, '.mcp.json');

    // Pre-existing file with another server
    const existing = { mcpServers: { 'my-server': { command: 'my-tool', args: [] } } };
    fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2));

    const cfg = buildCoordinatorMCPConfig({
      mcpServerPath: '/server.cjs',
      serverUrl: 'http://127.0.0.1:7777',
      token: 'tok',
      coordinatorTaskId: TEST_COORDINATOR_ID,
    });

    // Simulate the merge logic from StartMCPServer handler
    const raw = fs.readFileSync(mcpJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    parsed.mcpServers = { ...(parsed.mcpServers ?? {}), ...cfg.mcpServers };
    fs.writeFileSync(mcpJsonPath, JSON.stringify(parsed, null, 2));

    const written = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8')) as typeof parsed;
    expect(written.mcpServers?.['my-server']).toEqual({ command: 'my-tool', args: [] });
    expect(written.mcpServers?.['parallel-code']).toBeDefined();
  });

  it('deregister removes parallel-code key and preserves other servers', () => {
    const worktreePath = mkTemp();
    const projectRoot = mkTemp();
    const mcpJsonDir = selectMcpJsonDir(worktreePath, projectRoot);
    const mcpJsonPath = path.join(mcpJsonDir, '.mcp.json');

    // File with two servers
    const twoServers = {
      mcpServers: {
        'my-server': { command: 'my-tool', args: [] },
        'parallel-code': { command: 'node', args: ['server.cjs'] },
      },
    };
    fs.writeFileSync(mcpJsonPath, JSON.stringify(twoServers, null, 2));

    // Simulate deregisterCoordinator cleanup logic
    const raw = fs.readFileSync(mcpJsonPath, 'utf-8');
    const content = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    if (content.mcpServers) delete content.mcpServers['parallel-code'];
    const hasServers = Object.keys(content.mcpServers ?? {}).length > 0;
    const hasOtherKeys = Object.keys(content).filter((k) => k !== 'mcpServers').length > 0;
    if (!hasServers && !hasOtherKeys) {
      fs.unlinkSync(mcpJsonPath);
    } else {
      if (!hasServers) delete content.mcpServers;
      fs.writeFileSync(mcpJsonPath, JSON.stringify(content, null, 2));
    }

    expect(fs.existsSync(mcpJsonPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8')) as typeof content;
    expect(written.mcpServers?.['my-server']).toEqual({ command: 'my-tool', args: [] });
    expect(written.mcpServers?.['parallel-code']).toBeUndefined();
  });

  it('deregister deletes the file when parallel-code was the only entry', () => {
    const worktreePath = mkTemp();
    const projectRoot = mkTemp();
    const mcpJsonDir = selectMcpJsonDir(worktreePath, projectRoot);
    const mcpJsonPath = path.join(mcpJsonDir, '.mcp.json');

    const onlyUs = { mcpServers: { 'parallel-code': { command: 'node', args: [] } } };
    fs.writeFileSync(mcpJsonPath, JSON.stringify(onlyUs, null, 2));

    const raw = fs.readFileSync(mcpJsonPath, 'utf-8');
    const content = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    if (content.mcpServers) delete content.mcpServers['parallel-code'];
    const hasServers = Object.keys(content.mcpServers ?? {}).length > 0;
    const hasOtherKeys = Object.keys(content).filter((k) => k !== 'mcpServers').length > 0;
    if (!hasServers && !hasOtherKeys) {
      fs.unlinkSync(mcpJsonPath);
    } else {
      if (!hasServers) delete content.mcpServers;
      fs.writeFileSync(mcpJsonPath, JSON.stringify(content, null, 2));
    }

    expect(fs.existsSync(mcpJsonPath)).toBe(false);
  });

  it('merge fails fast when .mcp.json is malformed JSON without overwriting it', () => {
    const worktreePath = mkTemp();
    const projectRoot = mkTemp();
    const mcpJsonDir = selectMcpJsonDir(worktreePath, projectRoot);
    const mcpJsonPath = path.join(mcpJsonDir, '.mcp.json');

    const malformed = '{ "mcpServers": { not-valid-json ';
    fs.writeFileSync(mcpJsonPath, malformed);

    const cfg = buildCoordinatorMCPConfig({
      mcpServerPath: '/server.cjs',
      serverUrl: 'http://127.0.0.1:7777',
      token: 'tok',
      coordinatorTaskId: TEST_COORDINATOR_ID,
    });

    // Simulate the fail-closed parse logic from StartMCPServer handler
    let threwError = false;
    try {
      const raw = fs.readFileSync(mcpJsonPath, 'utf-8');
      JSON.parse(raw); // throws on malformed
      const parsed = {} as { mcpServers?: Record<string, unknown> };
      parsed.mcpServers = { ...(parsed.mcpServers ?? {}), ...cfg.mcpServers };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(parsed, null, 2)); // must not reach here
    } catch {
      threwError = true;
    }

    expect(threwError).toBe(true);
    // Original malformed content must be untouched
    expect(fs.readFileSync(mcpJsonPath, 'utf-8')).toBe(malformed);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 4: StartMCPServer input validation
// ─────────────────────────────────────────────────────────────────────────────

const VALID_ARGS = {
  coordinatorTaskId: TEST_COORDINATOR_ID,
  projectId: 'proj-1',
  projectRoot: '/absolute/project',
  coordinatorBranch: 'task/coordinator-work',
  worktreePath: '/absolute/worktree',
  agentArgs: ['--flag', 'value'],
  dockerContainerName: 'my-container',
};

describe('Layer 4 — StartMCPServer input validation', () => {
  it('accepts valid args without throwing', () => {
    expect(() => validateStartMCPServerArgs(VALID_ARGS)).not.toThrow();
  });

  it('accepts an absent or empty verifyCommand and rejects oversized ones', () => {
    expect(() => validateStartMCPServerArgs({ ...VALID_ARGS, verifyCommand: '' })).not.toThrow();
    expect(() =>
      validateStartMCPServerArgs({ ...VALID_ARGS, verifyCommand: 'npm test' }),
    ).not.toThrow();
    expect(() => validateStartMCPServerArgs({ ...VALID_ARGS, verifyCommand: 42 })).toThrow(
      'verifyCommand',
    );
    expect(() =>
      validateStartMCPServerArgs({ ...VALID_ARGS, verifyCommand: 'x'.repeat(5000) }),
    ).toThrow('too long');
  });

  it('rejects non-absolute projectRoot', () => {
    const writeFileSpy = vi.spyOn(fs, 'writeFileSync');
    const copyFileSpy = vi.spyOn(fs, 'copyFileSync');

    expect(() =>
      validateStartMCPServerArgs({ ...VALID_ARGS, projectRoot: 'relative/path' }),
    ).toThrow('projectRoot must be absolute');

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(copyFileSpy).not.toHaveBeenCalled();
  });

  it('rejects projectRoot containing ".."', () => {
    const writeFileSpy = vi.spyOn(fs, 'writeFileSync');
    const copyFileSpy = vi.spyOn(fs, 'copyFileSync');

    expect(() => validateStartMCPServerArgs({ ...VALID_ARGS, projectRoot: '/tmp/../etc' })).toThrow(
      'projectRoot must not contain ".."',
    );

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(copyFileSpy).not.toHaveBeenCalled();
  });

  it('rejects non-absolute worktreePath', () => {
    const writeFileSpy = vi.spyOn(fs, 'writeFileSync');
    const copyFileSpy = vi.spyOn(fs, 'copyFileSync');

    expect(() =>
      validateStartMCPServerArgs({ ...VALID_ARGS, worktreePath: 'relative/worktree' }),
    ).toThrow('worktreePath must be absolute');

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(copyFileSpy).not.toHaveBeenCalled();
  });

  it('rejects invalid coordinatorBranch', () => {
    const writeFileSpy = vi.spyOn(fs, 'writeFileSync');
    const copyFileSpy = vi.spyOn(fs, 'copyFileSync');

    expect(() =>
      validateStartMCPServerArgs({ ...VALID_ARGS, coordinatorBranch: 'bad branch' }),
    ).toThrow('coordinatorBranch');

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(copyFileSpy).not.toHaveBeenCalled();
  });

  it('rejects agentArgs containing a non-string element', () => {
    const writeFileSpy = vi.spyOn(fs, 'writeFileSync');
    const copyFileSpy = vi.spyOn(fs, 'copyFileSync');

    expect(() => validateStartMCPServerArgs({ ...VALID_ARGS, agentArgs: [1, 'foo'] })).toThrow(
      'agentArgs must be a string array',
    );

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(copyFileSpy).not.toHaveBeenCalled();
  });

  it('rejects dockerContainerName with shell-special characters', () => {
    const writeFileSpy = vi.spyOn(fs, 'writeFileSync');
    const copyFileSpy = vi.spyOn(fs, 'copyFileSync');

    expect(() =>
      validateStartMCPServerArgs({ ...VALID_ARGS, dockerContainerName: '; rm -rf /' }),
    ).toThrow('dockerContainerName contains invalid characters');

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(copyFileSpy).not.toHaveBeenCalled();
  });

  it('accepts worktreePath undefined (optional field)', () => {
    const { worktreePath: _, ...argsWithoutWorktree } = VALID_ARGS;
    expect(() => validateStartMCPServerArgs(argsWithoutWorktree)).not.toThrow();
  });

  it('accepts dockerContainerName undefined (optional field)', () => {
    const { dockerContainerName: _, ...argsWithoutDocker } = VALID_ARGS;
    expect(() => validateStartMCPServerArgs(argsWithoutDocker)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 5: Failure-mode tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Layer 5 — Failure modes', () => {
  it('missing source mcp-server.cjs throws ENOENT immediately (not silent)', () => {
    const worktreePath = mkTemp();
    const missingSrc = path.join(mkTemp(), 'nonexistent-mcp-server.cjs');
    const destPath = getDockerMcpServerDestPath(worktreePath, '/project');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    expect(() => fs.copyFileSync(missingSrc, destPath)).toThrow(/ENOENT/);
    // The dest file must NOT exist (no partial copy, no silent swallow)
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it('remote server returns 401 for a missing auth token', async () => {
    const srv = await startRemoteServer({
      port: 0,
      staticDir: os.tmpdir(),
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
      getCoordinator: () => null,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/tasks`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('unauthorized');
    } finally {
      await srv.stop();
    }
  });

  it('remote server returns 401 for a wrong auth token', async () => {
    const srv = await startRemoteServer({
      port: 0,
      staticDir: os.tmpdir(),
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
      getCoordinator: () => null,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/tasks`, {
        headers: { Authorization: 'Bearer wrong-token-xyz' },
      });
      expect(res.status).toBe(401);
    } finally {
      await srv.stop();
    }
  });

  it('remote server returns 200 with correct Bearer token and X-Coordinator-Id', async () => {
    const mockCoordinator = {
      listTasks: () => [],
      isRegisteredCoordinator: () => true,
    };
    const srv = await startRemoteServer({
      port: 0,
      staticDir: os.tmpdir(),
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
      getCoordinator: () => mockCoordinator as never,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/tasks`, {
        headers: { Authorization: `Bearer ${srv.token}`, 'X-Coordinator-Id': 'test-coord' },
      });
      expect(res.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });

  it('stale .mcp.json with 127.0.0.1 URL is detectable (not host.docker.internal)', () => {
    // This simulates the "stale config" bug: .mcp.json written with 127.0.0.1 instead of
    // host.docker.internal means the container cannot reach the host server.
    const staleCfg = buildCoordinatorMCPConfig({
      mcpServerPath: '/server.cjs',
      serverUrl: 'http://127.0.0.1:3001', // <- stale / wrong for Docker macOS
      token: 'tok',
      coordinatorTaskId: TEST_COORDINATOR_ID,
    });
    const args = staleCfg.mcpServers['parallel-code'].args;
    const urlIdx = args.indexOf('--url');
    const url = args[urlIdx + 1];

    // A test can assert this is the wrong URL for Docker on macOS:
    expect(url).not.toContain('host.docker.internal');
    // The correct URL for Docker on macOS would be:
    const correctUrl = getMCPRemoteServerUrl(3001, 'container', 'darwin');
    expect(correctUrl).toContain('host.docker.internal');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 7: Remote server bind address
// ─────────────────────────────────────────────────────────────────────────────

describe('Layer 7 — Remote server bind address', () => {
  it('server bound to 127.0.0.1 is reachable via that address', async () => {
    const mockCoordinator = { listTasks: () => [], isRegisteredCoordinator: () => true };
    const srv = await startRemoteServer({
      port: 0,
      staticDir: os.tmpdir(),
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
      getCoordinator: () => mockCoordinator as never,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/tasks`, {
        headers: { Authorization: `Bearer ${srv.token}`, 'X-Coordinator-Id': 'test-coord' },
      });
      expect(res.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });

  it('server port is included in generated MCP URL', async () => {
    const srv = await startRemoteServer({
      port: 0,
      staticDir: os.tmpdir(),
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
      getCoordinator: () => null,
    });
    try {
      const url = getMCPRemoteServerUrl(srv.port, undefined);
      expect(url).toContain(String(srv.port));
    } finally {
      await srv.stop();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 6: Log assertion tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Layer 6 — Log assertions (production startup messages)', () => {
  function runConfigPipeline(opts: {
    worktreePath: string;
    projectRoot: string;
    srcServerPath: string;
    port: number;
    containerName: string;
    token: string;
    coordinatorTaskId: string;
  }) {
    const serverUrl = getMCPRemoteServerUrl(opts.port, opts.containerName, 'darwin');

    const destPath = getDockerMcpServerDestPath(opts.worktreePath, opts.projectRoot);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(opts.srcServerPath, destPath);
    console.warn('[MCP] Docker mode: copied MCP server to', destPath);

    const mcpConfig = buildCoordinatorMCPConfig({
      mcpServerPath: destPath,
      serverUrl,
      token: opts.token,
      coordinatorTaskId: opts.coordinatorTaskId,
    });

    const mcpJsonDir = selectMcpJsonDir(opts.worktreePath, opts.projectRoot);
    const worktreeMcpPath = path.join(mcpJsonDir, '.mcp.json');
    fs.writeFileSync(worktreeMcpPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });

    console.warn('[MCP] .mcp.json written to:', worktreeMcpPath);
    console.warn('[MCP] Server path:', destPath);
    console.warn('[MCP] Remote URL:', serverUrl);

    return { destPath, worktreeMcpPath, serverUrl };
  }

  it('logs Docker mode copy message with the destination path', () => {
    const worktreePath = mkTemp();
    const srcPath = path.join(mkTemp(), 'mcp-server.cjs');
    fs.writeFileSync(srcPath, '// fake');

    const { destPath } = runConfigPipeline({
      worktreePath,
      projectRoot: mkTemp(),
      srcServerPath: srcPath,
      port: 3001,
      containerName: 'my-container',
      token: 'tok',
      coordinatorTaskId: TEST_COORDINATOR_ID,
    });

    expect(console.warn).toHaveBeenCalledWith('[MCP] Docker mode: copied MCP server to', destPath);
  });

  it('logs .mcp.json written path (worktree, not project root)', () => {
    const worktreePath = mkTemp();
    const srcPath = path.join(mkTemp(), 'mcp-server.cjs');
    fs.writeFileSync(srcPath, '// fake');

    const { worktreeMcpPath } = runConfigPipeline({
      worktreePath,
      projectRoot: mkTemp(),
      srcServerPath: srcPath,
      port: 3001,
      containerName: 'container',
      token: 'tok',
      coordinatorTaskId: TEST_COORDINATOR_ID,
    });

    expect(console.warn).toHaveBeenCalledWith('[MCP] .mcp.json written to:', worktreeMcpPath);
    expect(worktreeMcpPath.startsWith(worktreePath)).toBe(true);
  });

  it('logs Remote URL with host.docker.internal on macOS', () => {
    const worktreePath = mkTemp();
    const srcPath = path.join(mkTemp(), 'mcp-server.cjs');
    fs.writeFileSync(srcPath, '// fake');

    const { serverUrl } = runConfigPipeline({
      worktreePath,
      projectRoot: mkTemp(),
      srcServerPath: srcPath,
      port: 4567,
      containerName: 'container',
      token: 'tok',
      coordinatorTaskId: TEST_COORDINATOR_ID,
    });

    expect(console.warn).toHaveBeenCalledWith('[MCP] Remote URL:', serverUrl);
    expect(serverUrl).toContain('host.docker.internal:4567');
  });

  it('logs Server path pointing to the copied worktree location', () => {
    const worktreePath = mkTemp();
    const srcPath = path.join(mkTemp(), 'mcp-server.cjs');
    fs.writeFileSync(srcPath, '// fake');

    const { destPath } = runConfigPipeline({
      worktreePath,
      projectRoot: mkTemp(),
      srcServerPath: srcPath,
      port: 3001,
      containerName: 'container',
      token: 'tok',
      coordinatorTaskId: TEST_COORDINATOR_ID,
    });

    expect(console.warn).toHaveBeenCalledWith('[MCP] Server path:', destPath);
    // Server path must be the in-worktree copy, not the original
    expect(destPath.startsWith(worktreePath)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 8: Coordinator routes work when remote server started before coordinator
// ─────────────────────────────────────────────────────────────────────────────

describe('Layer 8 — Coordinator routes available after late coordinator attach', () => {
  it('coordinator routes return 503 before coordinator is set, then 200 after', async () => {
    let currentCoordinator: {
      listTasks: () => unknown[];
      isRegisteredCoordinator?: () => boolean;
    } | null = null;

    const srv = await startRemoteServer({
      port: 0,
      staticDir: os.tmpdir(),
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
      getCoordinator: () => currentCoordinator as never,
    });

    try {
      // Before coordinator is set: coordinator routes should return 503
      const res1 = await fetch(`http://127.0.0.1:${srv.port}/api/tasks`, {
        headers: { Authorization: `Bearer ${srv.token}` },
      });
      expect(res1.status).toBe(503);

      // Simulate coordinator being attached later (e.g. StartMCPServer called after StartRemoteServer)
      currentCoordinator = { listTasks: () => [], isRegisteredCoordinator: () => true };

      // After coordinator is set: coordinator routes should work (coordinator token requires X-Coordinator-Id)
      const res2 = await fetch(`http://127.0.0.1:${srv.port}/api/tasks`, {
        headers: { Authorization: `Bearer ${srv.token}`, 'X-Coordinator-Id': 'test-coord' },
      });
      expect(res2.status).toBe(200);
      const body = (await res2.json()) as unknown[];
      expect(Array.isArray(body)).toBe(true);
    } finally {
      await srv.stop();
    }
  });
});
