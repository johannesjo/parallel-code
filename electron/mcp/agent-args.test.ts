import { describe, expect, it } from 'vitest';

import {
  buildCodexMcpConfigOverride,
  buildMcpLaunchArgs,
  isAntigravityCommand,
  isCodexCommand,
  isCopilotCommand,
} from './agent-args.js';

const config = {
  mcpServers: {
    'parallel-code': {
      command: 'node',
      args: ['/tmp/mcp-server.cjs', '--url', 'http://127.0.0.1:1234', '--coordinator-id', 'task-1'],
      env: {
        PARALLEL_CODE_MCP_TOKEN: 'token-1',
      },
    },
  },
};

describe('MCP agent launch args', () => {
  it('detects codex commands by executable name', () => {
    expect(isCodexCommand('codex')).toBe(true);
    expect(isCodexCommand('/opt/homebrew/bin/codex')).toBe(true);
    expect(isCodexCommand('claude')).toBe(false);
  });

  it('builds Codex inline config overrides instead of --mcp-config', () => {
    expect(buildMcpLaunchArgs('codex', '/tmp/config.json', config)).toEqual([
      '--config',
      buildCodexMcpConfigOverride(config),
    ]);
  });

  it('quotes Codex inline config env keys so non-bare TOML keys remain valid', () => {
    const override = buildCodexMcpConfigOverride({
      mcpServers: {
        'parallel-code': {
          command: 'node',
          args: [],
          env: {
            'TOKEN.WITH.DOTS': 'token-1',
          },
        },
      },
    });

    expect(override).toContain('"TOKEN.WITH.DOTS" = "token-1"');
  });

  it('uses --mcp-config for Claude-compatible agents', () => {
    expect(buildMcpLaunchArgs('claude', '/tmp/config.json', config)).toEqual([
      '--mcp-config',
      '/tmp/config.json',
    ]);
  });

  it('detects antigravity commands by executable name', () => {
    expect(isAntigravityCommand('agy')).toBe(true);
    expect(isAntigravityCommand('/home/agent/.local/bin/agy')).toBe(true);
    expect(isAntigravityCommand('claude')).toBe(false);
  });

  it('emits no --mcp-config for Antigravity', () => {
    expect(buildMcpLaunchArgs('agy', '/tmp/config.json', config)).toEqual([]);
  });

  it('detects copilot commands by executable name', () => {
    expect(isCopilotCommand('copilot')).toBe(true);
    expect(isCopilotCommand('/opt/homebrew/bin/copilot')).toBe(true);
    expect(isCopilotCommand('claude')).toBe(false);
  });

  it('uses --additional-mcp-config for Copilot instead of the unsupported --mcp-config', () => {
    expect(buildMcpLaunchArgs('copilot', '/tmp/config.json', config)).toEqual([
      '--additional-mcp-config',
      '@/tmp/config.json',
    ]);
  });

  it('emits no MCP args for Copilot when no config path is available', () => {
    expect(buildMcpLaunchArgs('copilot', undefined, config)).toEqual([]);
  });
});
