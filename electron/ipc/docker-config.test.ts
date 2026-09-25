/**
 * Layer 1 — Docker coordinator config (pure, no Docker required)
 *
 * Fast unit tests for the pure functions that generate MCP config for Docker coordinators.
 * No Docker, no network, no filesystem writes.
 */

import { describe, expect, it } from 'vitest';
import { buildCoordinatorMCPConfig, selectMcpJsonDir } from './register.js';
import { getDockerMcpServerDestPath } from './mcp-paths.js';
import { getMCPRemoteServerUrl } from '../mcp/config.js';

// ── MCP server URL ─────────────────────────────────────────────────────────────

describe('getMCPRemoteServerUrl — host resolution', () => {
  it('uses host.docker.internal on macOS Docker Desktop', () => {
    expect(getMCPRemoteServerUrl(3001, 'my-container', 'darwin')).toBe(
      'http://host.docker.internal:3001',
    );
  });

  it('uses 127.0.0.1 on Linux (--network host makes localhost IS the host)', () => {
    // --add-host=host.docker.internal:host-gateway is incompatible with --network host on Linux.
    // With --network host the container shares the host network stack, so 127.0.0.1 IS the host.
    expect(getMCPRemoteServerUrl(3001, 'my-container', 'linux')).toBe('http://127.0.0.1:3001');
  });

  it('uses 127.0.0.1 when no container name (non-Docker)', () => {
    expect(getMCPRemoteServerUrl(3001, undefined)).toBe('http://127.0.0.1:3001');
  });

  it('uses 127.0.0.1 when container name is empty string', () => {
    expect(getMCPRemoteServerUrl(3001, '')).toBe('http://127.0.0.1:3001');
  });
});

// ── .mcp.json placement ────────────────────────────────────────────────────────

describe('selectMcpJsonDir — .mcp.json placement', () => {
  it('places .mcp.json in worktreePath when provided', () => {
    expect(selectMcpJsonDir('/worktrees/coord-abc', '/project')).toBe('/worktrees/coord-abc');
  });

  it('falls back to projectRoot when worktreePath is undefined', () => {
    expect(selectMcpJsonDir(undefined, '/project')).toBe('/project');
  });

  it('worktreePath wins over projectRoot (Docker: container only mounts worktree)', () => {
    const worktreePath = '/Users/alice/repo/.worktrees/task/coord-abc123';
    const projectRoot = '/Users/alice/repo';
    const dir = selectMcpJsonDir(worktreePath, projectRoot);
    // .mcp.json must be inside the volume-mounted worktree, not the projectRoot (not mounted)
    expect(dir).toBe(worktreePath);
    expect(dir).not.toBe(projectRoot);
  });
});

// ── copied mcp-server.cjs path ─────────────────────────────────────────────────

describe('getDockerMcpServerDestPath — copied mcp-server.cjs location', () => {
  it('places mcp-server.cjs in worktree .parallel-code dir', () => {
    const dest = getDockerMcpServerDestPath('/worktrees/coord', '/project');
    expect(dest).toBe('/worktrees/coord/.parallel-code/mcp-server.cjs');
  });

  it('falls back to projectRoot when worktreePath is undefined', () => {
    const dest = getDockerMcpServerDestPath(undefined, '/project');
    expect(dest).toBe('/project/.parallel-code/mcp-server.cjs');
  });

  it('dest is under the mounted worktree, not the unmounted projectRoot', () => {
    const worktreePath = '/home/user/repo/.worktrees/task/coord-abc123';
    const projectRoot = '/home/user/repo';
    const dest = getDockerMcpServerDestPath(worktreePath, projectRoot);
    // The container mounts worktreePath (not projectRoot), so the script must live there
    expect(dest.startsWith(worktreePath)).toBe(true);
    expect(dest.startsWith(projectRoot + '/.parallel-code')).toBe(false);
  });

  it('filename is always mcp-server.cjs', () => {
    const dest = getDockerMcpServerDestPath('/worktrees/coord', '/project');
    expect(dest.endsWith('/mcp-server.cjs')).toBe(true);
  });
});

// ── .mcp.json config content ───────────────────────────────────────────────────

describe('buildCoordinatorMCPConfig — config content', () => {
  const baseOpts = {
    mcpServerPath: '/worktrees/coord/.parallel-code/mcp-server.cjs',
    serverUrl: 'http://host.docker.internal:3001',
    token: 'test-token-abc',
    coordinatorTaskId: 'coord-task-1',
  };

  it('has type:stdio and command:node', () => {
    const cfg = buildCoordinatorMCPConfig(baseOpts);
    const server = cfg.mcpServers['parallel-code'];
    expect(server.type).toBe('stdio');
    expect(server.command).toBe('node');
  });

  it('args[0] is the mcp-server.cjs path (the copied worktree path, not host path)', () => {
    const cfg = buildCoordinatorMCPConfig(baseOpts);
    expect(cfg.mcpServers['parallel-code'].args[0]).toBe(baseOpts.mcpServerPath);
  });

  it('args contain --url pointing to host.docker.internal', () => {
    const cfg = buildCoordinatorMCPConfig(baseOpts);
    const args = cfg.mcpServers['parallel-code'].args;
    const urlIdx = args.indexOf('--url');
    expect(urlIdx).toBeGreaterThan(0);
    expect(args[urlIdx + 1]).toBe('http://host.docker.internal:3001');
  });

  it('token is passed via env var, not args', () => {
    const cfg = buildCoordinatorMCPConfig(baseOpts);
    const args = cfg.mcpServers['parallel-code'].args;
    expect(args).not.toContain('--token');
    expect(cfg.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).toBe(baseOpts.token);
  });

  it('args contain --coordinator-id', () => {
    const cfg = buildCoordinatorMCPConfig(baseOpts);
    const args = cfg.mcpServers['parallel-code'].args;
    const coordIdx = args.indexOf('--coordinator-id');
    expect(coordIdx).toBeGreaterThan(0);
    expect(args[coordIdx + 1]).toBe(baseOpts.coordinatorTaskId);
  });

  it('omits --skip-permissions by default', () => {
    const cfg = buildCoordinatorMCPConfig(baseOpts);
    expect(cfg.mcpServers['parallel-code'].args).not.toContain('--skip-permissions');
  });

  it('adds --skip-permissions when both flags are true', () => {
    const cfg = buildCoordinatorMCPConfig({
      ...baseOpts,
      skipPermissions: true,
      propagateSkipPermissions: true,
    });
    expect(cfg.mcpServers['parallel-code'].args).toContain('--skip-permissions');
  });

  it('does NOT add --skip-permissions when propagateSkipPermissions is false', () => {
    const cfg = buildCoordinatorMCPConfig({
      ...baseOpts,
      skipPermissions: true,
      propagateSkipPermissions: false,
    });
    expect(cfg.mcpServers['parallel-code'].args).not.toContain('--skip-permissions');
  });

  it('does NOT add --skip-permissions when skipPermissions is false', () => {
    const cfg = buildCoordinatorMCPConfig({
      ...baseOpts,
      skipPermissions: false,
      propagateSkipPermissions: true,
    });
    expect(cfg.mcpServers['parallel-code'].args).not.toContain('--skip-permissions');
  });

  it('JSON-serialised output is valid JSON with the parallel-code key', () => {
    const cfg = buildCoordinatorMCPConfig(baseOpts);
    const json = JSON.stringify(cfg, null, 2);
    const parsed = JSON.parse(json) as typeof cfg;
    expect(parsed.mcpServers['parallel-code']).toBeDefined();
  });
});
