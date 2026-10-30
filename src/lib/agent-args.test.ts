import { describe, expect, it } from 'vitest';
import { reviewerWithModel } from './agent-handoff';

import {
  buildTaskAgentArgs,
  effortInArgs,
  isResumeArgsFailure,
  modelInArgs,
  taskAgentOpensSessionPicker,
} from './agent-args';

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

describe('buildTaskAgentArgs with pane flags', () => {
  const SESSION = 'fb4f2bc6-62d9-4b29-a795-240caf2fc459';
  const claudeWithFlags = { ...claudeAgent, extra_args: ['--chrome'] };

  it('adds the flags when resuming the pane session', () => {
    expect(
      buildTaskAgentArgs(claudeWithFlags, { skipPermissions: true }, true, undefined, SESSION),
    ).toEqual(['--resume', SESSION, '--chrome', '--dangerously-skip-permissions']);
  });

  it('keeps the flags on a fresh launch', () => {
    expect(buildTaskAgentArgs(claudeWithFlags, {}, false, undefined, SESSION)).toEqual([
      '--session-id',
      SESSION,
      '--chrome',
    ]);
  });
});

describe('buildTaskAgentArgs with a session id', () => {
  const SESSION = 'fb4f2bc6-62d9-4b29-a795-240caf2fc459';
  const claudeWithContinue = { ...claudeAgent, resume_args: ['--continue'] };

  it('names a new Claude session', () => {
    expect(buildTaskAgentArgs(claudeAgent, {}, false, undefined, SESSION)).toEqual([
      '--session-id',
      SESSION,
    ]);
  });

  it('resumes that Claude session by id instead of --continue', () => {
    expect(buildTaskAgentArgs(claudeWithContinue, {}, true, undefined, SESSION)).toEqual([
      '--resume',
      SESSION,
    ]);
  });

  it('resumes the owned Claude terminal session even when a separate chat exists', () => {
    expect(
      buildTaskAgentArgs(
        claudeWithContinue,
        { claudeChatSessionId: 'other-chat' },
        true,
        'primary',
        SESSION,
      ),
    ).toEqual(['--resume', SESSION]);
  });

  it('resumes that Codex session by id instead of resume --last', () => {
    expect(buildTaskAgentArgs(codexAgent, {}, true, undefined, SESSION)).toEqual([
      'resume',
      SESSION,
    ]);
  });

  // Codex takes no id for a fresh session, so it keeps its normal launch args.
  it('starts Codex normally when it cannot be handed an id', () => {
    expect(buildTaskAgentArgs(codexAgent, {}, false, undefined, SESSION)).toEqual([]);
  });

  it.each([
    ['antigravity', antigravityAgent, ['-c']],
    ['copilot', copilotAgent, ['--continue']],
  ])('leaves %s on its positional resume', (_label, agent, expected) => {
    expect(buildTaskAgentArgs(agent, {}, true, undefined, SESSION)).toEqual(expected);
  });

  // An explicit id is exactly what the document-workspace picker works around,
  // so it must win over that rewrite rather than be overridden by it.
  it('overrides the shared-checkout picker for a document agent', () => {
    expect(
      buildTaskAgentArgs(claudeWithContinue, { id: 'doc-agent-docs' }, true, undefined, SESSION),
    ).toEqual(['--resume', SESSION]);
  });

  it('still appends skip-permissions and MCP args', () => {
    expect(
      buildTaskAgentArgs(
        claudeAgent,
        { skipPermissions: true, mcpLaunchArgs: ['--mcp-config', '/tmp/c.json'] },
        false,
        undefined,
        SESSION,
      ),
    ).toEqual([
      '--session-id',
      SESSION,
      '--dangerously-skip-permissions',
      '--mcp-config',
      '/tmp/c.json',
    ]);
  });

  it('keeps the session picker when a reviewer has a model override', () => {
    const codex = reviewerWithModel(codexAgent, 'codex-test');
    const claude = reviewerWithModel({ ...claudeAgent, resume_args: ['--continue'] }, 'opus');
    const chats = { codexChatThreadId: 'chat-thread', claudeChatSessionId: 'chat' };
    expect(buildTaskAgentArgs(codex, chats, true)).toEqual(['resume', '--model', 'codex-test']);
    expect(buildTaskAgentArgs(claude, chats, true)).toEqual(['--resume', '--model', 'opus']);
    expect(taskAgentOpensSessionPicker(codex, chats, true)).toBe(true);
    expect(taskAgentOpensSessionPicker(claude, chats, true)).toBe(true);
  });

  it('replaces a configured reasoning level for a reviewer and keeps the session picker', () => {
    const codex = reviewerWithModel(
      { ...codexAgent, args: ['-c', 'model_reasoning_effort="low"', '-c', 'x=1'] },
      '',
      'high',
    );
    const claude = reviewerWithModel(
      { ...claudeAgent, args: ['--effort', 'low', '--effort=low'], resume_args: ['--continue'] },
      'opus',
      'max',
    );
    expect(codex.args).toEqual(['-c', 'x=1', '-c', 'model_reasoning_effort="high"']);
    expect(claude.args).toEqual(['--model', 'opus', '--effort', 'max']);
    const chats = { codexChatThreadId: 'chat-thread', claudeChatSessionId: 'chat' };
    expect(buildTaskAgentArgs(codex, chats, true)).toEqual([
      'resume',
      '-c',
      'model_reasoning_effort="high"',
    ]);
    expect(taskAgentOpensSessionPicker(codex, chats, true)).toBe(true);
    expect(taskAgentOpensSessionPicker(claude, chats, true)).toBe(true);
  });

  it('keeps a configured reasoning level when the reviewer uses the default', () => {
    const claude = reviewerWithModel({ ...claudeAgent, args: ['--effort', 'high'] }, 'opus');
    expect(claude.args).toEqual(['--effort', 'high', '--model', 'opus']);
    const gemini = { ...codexAgent, command: 'gemini', args: ['--effort', 'low'] };
    expect(reviewerWithModel(gemini, '', 'high')).toBe(gemini);
  });

  it('restores the latest Codex session after restart when no session id was saved', () => {
    expect(buildTaskAgentArgs(codexAgent, {}, true, undefined)).toEqual(['resume', '--last']);
    expect(taskAgentOpensSessionPicker(codexAgent, {}, true)).toBe(false);
  });

  it('offers the picker for a full-path Codex command and an invalid saved id', () => {
    expect(
      buildTaskAgentArgs(
        { ...codexAgent, command: '/usr/local/bin/codex' },
        { codexChatThreadId: 'chat-thread' },
        true,
        undefined,
        '--invalid',
      ),
    ).toEqual(['resume']);
  });

  it('preserves a configured explicit Codex session without a saved id', () => {
    const def = { ...codexAgent, resume_args: ['resume', 'specific-session'] };
    expect(buildTaskAgentArgs(def, {}, true)).toEqual(def.resume_args);
    expect(buildTaskAgentArgs(codexAgent, {}, false)).toEqual([]);
  });

  it('preserves custom launch options when naming a new Claude session', () => {
    const def = { ...claudeAgent, args: ['--model', 'sonnet', '--permission-mode', 'plan'] };
    expect(buildTaskAgentArgs(def, {}, false, undefined, SESSION)).toEqual([
      '--session-id',
      SESSION,
      ...def.args,
    ]);
  });

  it.each([
    ['--continue'],
    ['-c'],
    ['--resume'],
    ['--resume', 'old-session'],
    ['-r', 'old-session'],
    ['--resume=old-session'],
    ['--session-id', SESSION],
    [`--session-id=${SESSION}`],
  ])('replaces Claude selectors %j without dropping resume options', (...selector) => {
    const options = ['--model', 'sonnet', '--permission-mode', 'plan'];
    const def = { ...claudeAgent, resume_args: [...selector, ...options] };
    expect(buildTaskAgentArgs(def, {}, true, undefined, SESSION)).toEqual([
      '--resume',
      SESSION,
      ...options,
    ]);
    expect(def.resume_args).toEqual([...selector, ...options]);
  });

  it.each([['resume', '--last'], ['resume', 'old-session'], ['resume']])(
    'preserves Codex resume options with selector %j',
    (...selector) => {
      const options = ['--model', 'custom-model', '--config', 'approval_policy="never"'];
      const def = { ...codexAgent, resume_args: [...selector, ...options] };
      expect(buildTaskAgentArgs(def, {}, true, undefined, SESSION)).toEqual([
        'resume',
        SESSION,
        ...options,
      ]);
    },
  );

  it('preserves prompt arguments after the option terminator', () => {
    const def = { ...claudeAgent, args: ['--', '--continue'] };
    expect(buildTaskAgentArgs(def, {}, false, undefined, SESSION)).toEqual([
      '--session-id',
      SESSION,
      '--',
      '--continue',
    ]);
  });

  it('keeps Codex options that precede the resume subcommand', () => {
    const def = { ...codexAgent, resume_args: ['--model', 'custom-model', 'resume', '--last'] };
    expect(buildTaskAgentArgs(def, {}, true, undefined, SESSION)).toEqual([
      'resume',
      SESSION,
      '--model',
      'custom-model',
    ]);
  });
});

describe('buildTaskAgentArgs', () => {
  it('offers a resume picker when a separate chat could be the latest Codex conversation', () => {
    expect(buildTaskAgentArgs(codexAgent, { codexChatThreadId: 'chat-thread' }, true)).toEqual([
      'resume',
    ]);
    expect(buildTaskAgentArgs(codexAgent, {}, true)).toEqual(['resume', '--last']);
  });
  it('offers a Claude resume picker only when chat could be the newest session', () => {
    const agent = { ...claudeAgent, resume_args: ['--continue'] };
    expect(buildTaskAgentArgs(agent, { claudeChatSessionId: 'chat' }, true)).toEqual(['--resume']);
    expect(buildTaskAgentArgs(agent, {}, true)).toEqual(['--continue']);
    expect(taskAgentOpensSessionPicker(agent, {}, true)).toBe(false);
    expect(buildTaskAgentArgs(agent, {}, false)).toEqual([]);
    expect(
      buildTaskAgentArgs(
        { ...agent, resume_args: ['--resume', 'explicit'] },
        { claudeChatSessionId: 'chat' },
        true,
      ),
    ).toEqual(['--resume', 'explicit']);
  });
  it('offers the Claude picker for a full-path command and an invalid saved id', () => {
    expect(
      buildTaskAgentArgs(
        { ...claudeAgent, command: '/usr/local/bin/claude', resume_args: ['--continue'] },
        {
          skipPermissions: true,
          mcpLaunchArgs: ['--mcp-config', '/tmp/mcp.json'],
          claudeChatSessionId: 'chat',
        },
        true,
        undefined,
        '--invalid',
      ),
    ).toEqual(['--resume', '--dangerously-skip-permissions', '--mcp-config', '/tmp/mcp.json']);
  });
  it.each([
    [codexAgent, ['resume']],
    [{ ...codexAgent, command: '/usr/local/bin/codex' }, ['resume']],
    [{ ...claudeAgent, resume_args: ['--continue'] }, ['--resume']],
    [copilotAgent, ['--resume']],
    [{ ...claudeAgent, command: 'gemini', resume_args: ['--resume', 'latest'] }, []],
    [antigravityAgent, []],
  ])(
    'does not select a different document terminal’s latest session: $command',
    (def, expected) => {
      expect(buildTaskAgentArgs(def, { id: 'doc-agent-docs' }, true)).toEqual(expected);
    },
  );

  it('preserves explicit document session IDs and fresh launches', () => {
    const def = { ...codexAgent, resume_args: ['resume', 'specific-session'] };
    expect(buildTaskAgentArgs(def, { id: 'doc-agent-docs' }, true)).toEqual(def.resume_args);
    expect(buildTaskAgentArgs(codexAgent, { id: 'doc-agent-docs' }, false)).toEqual([]);
  });

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

describe('taskAgentOpensSessionPicker', () => {
  it('does not block custom explicit sessions placed after options', () => {
    const id = 'fb4f2bc6-62d9-4b29-a795-240caf2fc459';
    const def = { ...codexAgent, resume_args: ['resume', '--model', 'custom', id] };
    expect(taskAgentOpensSessionPicker(def, {}, true)).toBe(false);
  });

  it('does not block custom Codex --last launches with additional options', () => {
    const def = { ...codexAgent, resume_args: ['resume', '--last', '--model', 'custom'] };
    expect(taskAgentOpensSessionPicker(def, {}, true)).toBe(false);
  });

  it('does not block an explicit chat handoff', () => {
    expect(
      taskAgentOpensSessionPicker(
        codexAgent,
        { agentIds: ['primary'], codexChatHandoff: { threadId: 'owned-thread' } },
        true,
        'primary',
      ),
    ).toBe(false);
  });
});

describe('isResumeArgsFailure', () => {
  describe('Claude resume failure patterns', () => {
    it('returns true when Claude reports no conversation to continue', () => {
      expect(isResumeArgsFailure('claude', ['No conversation found to continue'])).toBe(true);
    });

    // What `--resume <id>` actually says, quoted from claude 2.1.274. It is a
    // different string from the `--continue` one above, and now that panes
    // carry an explicit id it is the one they hit — a pane whose session has
    // been pruned would otherwise fail to launch on every restart forever.
    it('returns true when Claude cannot find the session id it was given', () => {
      expect(
        isResumeArgsFailure('claude', [
          'No conversation found with session ID: 00000000-0000-4000-8000-000000000000',
        ]),
      ).toBe(true);
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

describe('buildTaskAgentArgs — skip-permissions on a degraded definition', () => {
  // The failure this guards: a def can reach a launch path with no skip args at
  // all — restored from a profile written before the field existed, or built
  // from a bare command — and reading the field directly downgrades an explicit
  // opt-in to a launch that prompts on every tool call, with nothing logged.
  const degradedClaude = {
    id: 'claude',
    name: 'Claude',
    description: '',
    command: 'claude',
    args: [],
    resume_args: [],
    skip_permissions_args: [],
  };

  const task = { skipPermissions: true, mcpConfigPath: undefined, mcpLaunchArgs: undefined };

  it('resolves the flag by command when the definition carries none', () => {
    expect(buildTaskAgentArgs(degradedClaude, task, false)).toContain(
      '--dangerously-skip-permissions',
    );
  });

  it('resolves it for a command given as an absolute path', () => {
    expect(
      buildTaskAgentArgs({ ...degradedClaude, command: '/opt/homebrew/bin/claude' }, task, false),
    ).toContain('--dangerously-skip-permissions');
  });

  it('still honours flags the definition does carry, so a custom flag wins', () => {
    expect(
      buildTaskAgentArgs({ ...degradedClaude, skip_permissions_args: ['--custom'] }, task, false),
    ).toEqual(['--custom']);
  });

  it('adds nothing when the task did not opt in', () => {
    expect(buildTaskAgentArgs(degradedClaude, { ...task, skipPermissions: false }, false)).toEqual(
      [],
    );
  });

  it('adds nothing for an agent that takes no such flag', () => {
    expect(buildTaskAgentArgs({ ...degradedClaude, command: 'opencode' }, task, false)).toEqual([]);
  });
});

it('resumes the handed-off Codex session with its selected model and reasoning', () => {
  const agent = {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    args: [],
    resume_args: ['resume', '--last'],
    skip_permissions_args: [],
    description: '',
  };
  const task = {
    agentIds: ['primary', 'secondary'],
    codexChatThreadId: 'old',
    codexChatHandoff: { threadId: 'exact', model: 'model-a', reasoningEffort: 'high' },
  };
  expect(buildTaskAgentArgs(agent, task, true, 'primary')).toEqual([
    'resume',
    'exact',
    '--model',
    'model-a',
    '-c',
    'model_reasoning_effort="high"',
  ]);
  expect(buildTaskAgentArgs(agent, task, false, 'primary')).toEqual([]);
  expect(buildTaskAgentArgs(agent, task, true, 'secondary')).toEqual(['resume']);
});

describe('the model and level a launch sets itself', () => {
  it('reads each spelling of the model flag, the last one winning as in the CLIs', () => {
    expect(modelInArgs(['--model', 'opus'])).toBe('opus');
    expect(modelInArgs(['-m', 'gpt-6-sol', '--model=gpt-6-luna'])).toBe('gpt-6-luna');
    expect(modelInArgs(['--resume'])).toBe('');
  });

  it("reads Claude's effort flag and Codex's config key", () => {
    expect(effortInArgs(['--effort', 'high'])).toBe('high');
    expect(effortInArgs(['--effort=low'])).toBe('low');
    expect(effortInArgs(['-c', 'model_reasoning_effort="xhigh"'])).toBe('xhigh');
    expect(effortInArgs(['-c', 'model=gpt-6-sol'])).toBe('');
  });
});

describe('buildTaskAgentArgs for a teleported web session', () => {
  const TELEPORT = 'session_011CUabcXYZ';
  const task = { teleportSessionId: TELEPORT, agentIds: ['a1'] };

  it('teleports the first launch of the first pane', () => {
    expect(buildTaskAgentArgs(claudeAgent, task, false, 'a1')).toEqual(['--teleport', TELEPORT]);
  });

  it('keeps permissions flags alongside the teleport', () => {
    expect(
      buildTaskAgentArgs(claudeAgent, { ...task, skipPermissions: true }, false, 'a1'),
    ).toEqual(['--teleport', TELEPORT, '--dangerously-skip-permissions']);
  });

  it('resumes positionally instead of teleporting again', () => {
    const claudeWithContinue = { ...claudeAgent, resume_args: ['--continue'] };
    expect(buildTaskAgentArgs(claudeWithContinue, task, true, 'a1')).toEqual(['--continue']);
  });

  it('starts a fresh session once the pane has its own id', () => {
    const SESSION = 'fb4f2bc6-62d9-4b29-a795-240caf2fc459';
    expect(buildTaskAgentArgs(claudeAgent, task, false, 'a1', SESSION)).toEqual([
      '--session-id',
      SESSION,
    ]);
  });

  it('ignores the teleport for other panes and other CLIs', () => {
    expect(buildTaskAgentArgs(claudeAgent, task, false, 'a2')).toEqual([]);
    expect(buildTaskAgentArgs(codexAgent, task, false, 'a1')).toEqual([]);
  });
});
