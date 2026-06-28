import { describe, expect, it } from 'vitest';

import { buildTaskAgentArgs, isResumeArgsFailure } from './agent-args';

const codexAgent = {
  id: 'codex',
  name: 'Codex',
  description: 'Codex agent',
  command: 'codex',
  args: [],
  resume_args: ['resume', '--last'],
  skip_permissions_args: ['--dangerously-bypass-approvals-and-sandbox'],
};

const claudeAgent = {
  id: 'claude',
  name: 'Claude',
  description: 'Claude agent',
  command: 'claude',
  args: [],
  resume_args: [],
  skip_permissions_args: ['--dangerously-skip-permissions'],
};

const antigravityAgent = {
  id: 'antigravity',
  name: 'Antigravity CLI',
  description: 'Antigravity agent',
  command: 'agy',
  args: [],
  resume_args: ['-c'],
  skip_permissions_args: ['--dangerously-skip-permissions'],
};

const copilotAgent = {
  id: 'copilot',
  name: 'Copilot CLI',
  description: 'Copilot agent',
  command: 'copilot',
  args: [],
  resume_args: ['--continue'],
  skip_permissions_args: ['--yolo'],
};

describe('buildTaskAgentArgs', () => {
  it('uses explicit MCP launch args when provided (new task)', () => {
    expect(
      buildTaskAgentArgs(
        codexAgent,
        {
          skipPermissions: true,
          mcpConfigPath: '/tmp/mcp.json',
          mcpLaunchArgs: ['--config', 'mcp_servers.parallel-code={ command = "node" }'],
        },
        false,
      ),
    ).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '--config',
      'mcp_servers.parallel-code={ command = "node" }',
    ]);
  });

  it('uses explicit MCP launch args when provided (resumed task)', () => {
    expect(
      buildTaskAgentArgs(
        codexAgent,
        {
          skipPermissions: true,
          mcpConfigPath: '/tmp/mcp.json',
          mcpLaunchArgs: ['--config', 'mcp_servers.parallel-code={ command = "node" }'],
        },
        true,
      ),
    ).toEqual([
      'resume',
      '--last',
      '--dangerously-bypass-approvals-and-sandbox',
      '--config',
      'mcp_servers.parallel-code={ command = "node" }',
    ]);
  });

  it('does not fall back to --mcp-config for Codex (new task, no args)', () => {
    expect(
      buildTaskAgentArgs(
        codexAgent,
        {
          skipPermissions: false,
          mcpConfigPath: '/tmp/mcp.json',
        },
        false,
      ),
    ).toEqual([]);
  });

  it('uses resume_args for Codex when resuming', () => {
    expect(
      buildTaskAgentArgs(
        codexAgent,
        {
          skipPermissions: false,
          mcpConfigPath: '/tmp/mcp.json',
        },
        true,
      ),
    ).toEqual(['resume', '--last']);
  });

  it('keeps --mcp-config fallback for Claude-compatible agents', () => {
    expect(
      buildTaskAgentArgs(
        claudeAgent,
        {
          skipPermissions: false,
          mcpConfigPath: '/tmp/mcp.json',
        },
        false,
      ),
    ).toEqual(['--mcp-config', '/tmp/mcp.json']);
  });

  it('does not fall back to --mcp-config for Antigravity', () => {
    expect(
      buildTaskAgentArgs(
        antigravityAgent,
        {
          skipPermissions: false,
          mcpConfigPath: '/tmp/mcp.json',
        },
        false,
      ),
    ).toEqual([]);
  });

  it('passes the resume flag for Antigravity without --mcp-config', () => {
    expect(
      buildTaskAgentArgs(
        antigravityAgent,
        {
          skipPermissions: false,
          mcpConfigPath: '/tmp/mcp.json',
        },
        true,
      ),
    ).toEqual(['-c']);
  });

  it('uses Copilot --additional-mcp-config fallback instead of the unsupported --mcp-config', () => {
    expect(
      buildTaskAgentArgs(
        copilotAgent,
        {
          skipPermissions: false,
          mcpConfigPath: '/tmp/mcp.json',
        },
        false,
      ),
    ).toEqual(['--additional-mcp-config', '@/tmp/mcp.json']);
  });

  it('passes the Copilot resume flag alongside the --additional-mcp-config fallback', () => {
    expect(
      buildTaskAgentArgs(
        copilotAgent,
        {
          skipPermissions: false,
          mcpConfigPath: '/tmp/mcp.json',
        },
        true,
      ),
    ).toEqual(['--continue', '--additional-mcp-config', '@/tmp/mcp.json']);
  });
});

describe('isResumeArgsFailure', () => {
  describe('Claude resume failure patterns', () => {
    it('returns true when Claude reports no conversation to continue', () => {
      expect(isResumeArgsFailure('claude', ['No conversation found to continue'])).toBe(true);
    });

    it('returns true for a Claude command with a full path', () => {
      expect(
        isResumeArgsFailure('/usr/local/bin/claude', ['No conversation found to continue']),
      ).toBe(true);
    });

    it('returns false when Claude output does not match a resume failure', () => {
      expect(isResumeArgsFailure('claude', ['Resuming conversation...'])).toBe(false);
    });

    it('matches Claude resume failures across multiple output lines', () => {
      expect(
        isResumeArgsFailure('claude', [
          '\x1b[1mClaude Code\x1b[22m',
          '────────────────────────────────',
          'No conversation found to continue',
          'Run claude without --continue to start a new conversation',
          '❯ ',
        ]),
      ).toBe(true);
    });
  });

  describe('unsupported commands', () => {
    it('returns false for commands without configured resume failure patterns', () => {
      expect(isResumeArgsFailure('unknown-agent', ['No conversation found to continue'])).toBe(
        false,
      );
    });

    it('returns false for full-path commands without configured resume failure patterns', () => {
      expect(
        isResumeArgsFailure('/usr/local/bin/unknown-agent', ['No conversation found to continue']),
      ).toBe(false);
    });
  });

  it('returns false for empty last output', () => {
    expect(isResumeArgsFailure('claude', [])).toBe(false);
  });
});
