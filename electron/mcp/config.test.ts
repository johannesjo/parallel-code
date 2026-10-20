import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildSubTaskMcpConfig,
  getMCPRemoteServerUrl,
  getSubTaskMcpConfigPath,
  detectStaleDockerMCPUrl,
  isAllowedSubTaskMcpConfigPath,
  writeSubTaskMcpConfig,
} from './config.js';

describe('getMCPRemoteServerUrl', () => {
  it('uses localhost for host-run MCP servers', () => {
    expect(getMCPRemoteServerUrl(7777)).toBe('http://127.0.0.1:7777');
  });

  it('uses host.docker.internal on macOS Docker Desktop', () => {
    expect(getMCPRemoteServerUrl(7777, 'parallel-code-container', 'darwin')).toBe(
      'http://host.docker.internal:7777',
    );
  });

  it('uses localhost on Linux (--network host shares host loopback)', () => {
    expect(getMCPRemoteServerUrl(7777, 'parallel-code-container', 'linux')).toBe(
      'http://127.0.0.1:7777',
    );
  });
});

describe('getSubTaskMcpConfigPath', () => {
  it('in Docker mode, places config in coordinator .parallel-code dir (the explicit volume)', () => {
    const serverPath = '/worktree/.parallel-code/mcp-server.cjs';
    expect(getSubTaskMcpConfigPath('my-container', serverPath, 'task-abc')).toBe(
      '/worktree/.parallel-code/subtask-task-abc.json',
    );
  });

  it('in Docker mode, never places config in the sub-task worktree (not a volume mount)', () => {
    const serverPath = '/coordinator-worktree/.parallel-code/mcp-server.cjs';
    const result = getSubTaskMcpConfigPath('my-container', serverPath, 'task-abc');
    expect(result).not.toContain('sub-task-worktree');
    expect(result).toContain('.parallel-code');
  });

  it('in host mode, places config in the OS temp directory', () => {
    const serverPath = '/usr/lib/parallel-code/mcp-server.cjs';
    expect(getSubTaskMcpConfigPath(null, serverPath, 'task-xyz', '/tmp')).toBe(
      '/tmp/parallel-code-subtask-task-xyz.json',
    );
  });

  it('in host mode with no container, uses OS tmpdir default', () => {
    const serverPath = '/usr/lib/parallel-code/mcp-server.cjs';
    const result = getSubTaskMcpConfigPath(undefined, serverPath, 'task-123');
    expect(result).toBe(join(tmpdir(), 'parallel-code-subtask-task-123.json'));
  });
});

describe('buildSubTaskMcpConfig', () => {
  it('builds a task-scoped stdio server config with subtask and done tokens', () => {
    const cfg = buildSubTaskMcpConfig({
      serverPath: '/worktree/.parallel-code/mcp-server.cjs',
      serverUrl: 'http://127.0.0.1:7777',
      subtaskToken: 'subtask-token',
      taskId: 'task-abc',
      doneToken: 'done-token',
    });

    expect(cfg).toEqual({
      mcpServers: {
        'parallel-code': {
          type: 'stdio',
          command: 'node',
          args: [
            '/worktree/.parallel-code/mcp-server.cjs',
            '--url',
            'http://127.0.0.1:7777',
            '--task-id',
            'task-abc',
          ],
          env: {
            PARALLEL_CODE_MCP_TOKEN: 'subtask-token',
            PARALLEL_CODE_MCP_DONE_TOKEN: 'done-token',
          },
        },
      },
    });
  });
});

describe('writeSubTaskMcpConfig', () => {
  it('writes the sub-task config as readable JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parallel-code-config-test-'));
    const configPath = join(dir, 'subtask-task-abc.json');
    const cfg = buildSubTaskMcpConfig({
      serverPath: '/srv/mcp-server.cjs',
      serverUrl: 'http://127.0.0.1:7777',
      subtaskToken: 'subtask-token',
      taskId: 'task-abc',
      doneToken: 'done-token',
    });

    try {
      await writeSubTaskMcpConfig(configPath, cfg);

      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(cfg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isAllowedSubTaskMcpConfigPath', () => {
  it('allows the host temp path generated for the task', () => {
    expect(
      isAllowedSubTaskMcpConfigPath('/tmp/parallel-code-subtask-task-abc.json', {
        taskId: 'task-abc',
        serverPath: '/worktree/.parallel-code/mcp-server.cjs',
        tempDir: '/tmp',
      }),
    ).toBe(true);
  });

  it('allows the Docker coordinator .parallel-code path generated for the task', () => {
    expect(
      isAllowedSubTaskMcpConfigPath('/worktree/.parallel-code/subtask-task-abc.json', {
        taskId: 'task-abc',
        serverPath: '/worktree/.parallel-code/mcp-server.cjs',
        dockerContainerName: 'parallel-code-coord',
        tempDir: '/tmp',
      }),
    ).toBe(true);
  });

  it('rejects the Docker coordinator path in host mode even when serverPath is present', () => {
    expect(
      isAllowedSubTaskMcpConfigPath('/worktree/.parallel-code/subtask-task-abc.json', {
        taskId: 'task-abc',
        serverPath: '/worktree/.parallel-code/mcp-server.cjs',
        tempDir: '/tmp',
      }),
    ).toBe(false);
  });

  it('rejects basename matches outside the generated host or Docker locations', () => {
    expect(
      isAllowedSubTaskMcpConfigPath('/tmp/elsewhere/subtask-task-abc.json', {
        taskId: 'task-abc',
        serverPath: '/worktree/.parallel-code/mcp-server.cjs',
        dockerContainerName: 'parallel-code-coord',
        tempDir: '/tmp',
      }),
    ).toBe(false);
  });
});

describe('detectStaleDockerMCPUrl — stale config detection', () => {
  it('returns null for non-Docker (no containerName)', () => {
    expect(detectStaleDockerMCPUrl('http://127.0.0.1:3001', undefined)).toBeNull();
    expect(detectStaleDockerMCPUrl('http://127.0.0.1:3001', '')).toBeNull();
  });

  it('returns warning on macOS when URL contains 127.0.0.1 and containerName is set', () => {
    const warning = detectStaleDockerMCPUrl('http://127.0.0.1:3001', 'my-container', 'darwin');
    expect(warning).not.toBeNull();
    expect(warning).toContain('127.0.0.1');
    expect(warning).toContain('host.docker.internal');
    expect(warning).toContain('my-container');
  });

  it('returns null on macOS when URL uses host.docker.internal', () => {
    expect(
      detectStaleDockerMCPUrl('http://host.docker.internal:3001', 'my-container', 'darwin'),
    ).toBeNull();
  });

  it('returns null on Linux even with 127.0.0.1 (host network makes it reachable)', () => {
    expect(detectStaleDockerMCPUrl('http://127.0.0.1:3001', 'my-container', 'linux')).toBeNull();
  });
});

it('composes child session capabilities with existing completion credentials', () => {
  const config = buildSubTaskMcpConfig({
    serverPath: '/server.cjs',
    serverUrl: 'http://localhost:7777',
    taskId: 'child',
    subtaskToken: 'session-token',
    doneToken: 'done-token',
    sessionCapabilities: { profile: 'child-review', canCreate: false, peers: true },
  });
  expect(config.mcpServers['parallel-code'].args).toEqual([
    '/server.cjs',
    '--url',
    'http://localhost:7777',
    '--task-id',
    'child',
    '--session-profile',
    'child-review',
    '--peer-tools',
  ]);
  expect(config.mcpServers['parallel-code'].env).toEqual({
    PARALLEL_CODE_MCP_TOKEN: 'session-token',
    PARALLEL_CODE_MCP_DONE_TOKEN: 'done-token',
  });
});
