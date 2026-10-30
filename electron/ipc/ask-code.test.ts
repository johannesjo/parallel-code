import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANGE_TOUR_TIMEOUT_MS, CHANGE_TOUR_PROMPT_LIMIT } from '../shared/change-tour-limits.js';
import {
  UNDERSTANDING_TIMEOUT_MS,
  UNDERSTANDING_PROMPT_LIMIT,
} from '../shared/understanding-limits.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('./pty.js', () => ({ validateCommand: vi.fn(), ENV_BLOCK_LIST: new Set(['PATH']) }));
vi.mock('./env-file.js', () => ({
  loadEnvFile: vi.fn(() => ({})),
  expandHome: (value: string) => value,
}));
vi.mock('./codex-models.js', () => ({
  listCodexModels: () => [],
  defaultCodexModel: () => 'gpt-6-astra',
  defaultCodexEffort: (model: string) => (model === 'gpt-6-astra' ? 'medium' : ''),
}));
vi.mock('./ask-code-minimax.js', () => ({
  askAboutCodeMinimax: vi.fn(),
  cancelAskAboutCodeMinimax: vi.fn(),
  isMinimaxRequestActive: () => false,
}));
import { askAboutCode, askCodeEnv, cancelAskAboutCode } from './ask-code.js';
import { isStructuredPurpose } from './ask-code-purpose.js';
import { loadEnvFile } from './env-file.js';
import { setProjectAgentEnv } from './project-env.js';

/** Every purpose, with the system prompt, deadline and prompt budget it must get. */
const PURPOSES = [
  {
    purpose: undefined,
    systemPrompt: 'Answer concisely about the selected code. Use markdown.',
    timeoutMs: 120_000,
    promptLimit: 50_000,
  },
  {
    purpose: 'tour',
    systemPrompt:
      'Return exactly one JSON object matching the requested tour schema. No markdown, commentary, or additional JSON objects.',
    timeoutMs: CHANGE_TOUR_TIMEOUT_MS,
    promptLimit: CHANGE_TOUR_PROMPT_LIMIT,
  },
  {
    purpose: 'understand',
    systemPrompt:
      'Return exactly one JSON object matching the requested understanding tour schema. No markdown, commentary, or additional JSON objects.',
    timeoutMs: UNDERSTANDING_TIMEOUT_MS,
    promptLimit: UNDERSTANDING_PROMPT_LIMIT,
  },
] as const;

const STRUCTURED = PURPOSES.filter((entry) => entry.purpose !== undefined);

function mockProc() {
  const proc = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
  return proc;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Claude code Q&A deadlines', () => {
  it.each(PURPOSES)(
    'uses the correct deadline and system prompt for purpose $purpose',
    ({ purpose, systemPrompt, timeoutMs }) => {
      vi.useFakeTimers();
      const proc = mockProc();
      const send = vi.fn();
      const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
      askAboutCode(win, {
        requestId: purpose ?? 'question',
        channelId: 'test',
        prompt: 'Explain this code',
        cwd: '/tmp',
        provider: 'claude',
        purpose,
      });
      expect(proc.stdin.end).toHaveBeenCalledTimes(purpose ? 1 : 0);
      expect(spawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([systemPrompt]),
        expect.any(Object),
      );
      vi.advanceTimersByTime(120_000);
      if (timeoutMs > 120_000) {
        expect(send).not.toHaveBeenCalled();
        expect(proc.kill).not.toHaveBeenCalled();
        vi.advanceTimersByTime(timeoutMs - 120_000);
      }
      expect(send).toHaveBeenCalledWith('channel:test', {
        type: 'error',
        text: `Request timed out after ${timeoutMs / 60_000} minutes.`,
      });
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      proc.emit('close', null);
      expect(send.mock.calls.filter(([, message]) => message.type === 'done')).toHaveLength(1);
    },
  );

  it.each(STRUCTURED)(
    'pipes a large $purpose prompt to Claude and handles an early stdin failure once',
    ({ purpose, promptLimit }) => {
      const proc = mockProc();
      const send = vi.fn();
      const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
      const prompt = 'x'.repeat(promptLimit);
      askAboutCode(win, {
        requestId: `large-${purpose}`,
        channelId: 'test',
        prompt,
        cwd: '/tmp',
        purpose,
      });
      expect(spawn).toHaveBeenCalledWith(
        'claude',
        expect.not.arrayContaining([prompt]),
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
      );
      expect(proc.stdin.end).toHaveBeenCalledExactlyOnceWith(prompt);
      proc.stdin.emit('error', new Error('broken pipe'));
      proc.emit('close', 1);
      expect(send).toHaveBeenCalledWith('channel:test', {
        type: 'error',
        text: 'Could not send tour prompt: broken pipe',
      });
      expect(send.mock.calls.filter(([, message]) => message.type === 'done')).toHaveLength(1);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    },
  );

  it.each(PURPOSES)(
    'rejects oversized prompts for purpose $purpose before spawning',
    ({ purpose, promptLimit }) => {
      const win = { isDestroyed: () => false } as unknown as BrowserWindow;
      expect(() =>
        askAboutCode(win, {
          requestId: 'too-large',
          channelId: 'test',
          prompt: 'x'.repeat(promptLimit + 1),
          cwd: '/tmp',
          purpose,
        }),
      ).toThrow(/Prompt too long/);
      expect(spawn).not.toHaveBeenCalled();
    },
  );
});

describe('Claude code Q&A model', () => {
  function spawnArgs(model?: string, effort?: string, purpose?: 'review' | 'task-name'): string[] {
    mockProc();
    const win = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    } as unknown as BrowserWindow;
    askAboutCode(win, {
      requestId: `model-${model ?? 'default'}`,
      channelId: 'test',
      prompt: 'Explain this code',
      cwd: '/tmp',
      provider: 'claude',
      model,
      effort,
      purpose,
    });
    return vi.mocked(spawn).mock.calls[0][1] as string[];
  }

  it('lets only a review read, confined to the worktree and with no MCP servers', () => {
    const answer = spawnArgs('opus');
    expect(answer[answer.indexOf('--tools') + 1]).toBe('');
    expect(answer).not.toContain('--strict-mcp-config');
    expect(answer).not.toContain('--restricted');
    vi.mocked(spawn).mockClear();
    const review = spawnArgs('opus', undefined, 'review');
    expect(review[review.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(review).toContain('--strict-mcp-config');
    expect(review).toContain('--restricted');
  });

  it('names a task without the Claude Code prompt and its repository context', () => {
    // Appended to that prompt, a vague task prompt reads as a question about the repo.
    const naming = spawnArgs('haiku', undefined, 'task-name');
    expect(naming).toContain('--system-prompt');
    expect(naming).not.toContain('--append-system-prompt');
    vi.mocked(spawn).mockClear();
    const answer = spawnArgs('opus');
    expect(answer).toContain('--append-system-prompt');
    expect(answer).not.toContain('--system-prompt');
  });

  it("gives a review only the login part of the user's Claude settings, which --restricted skips", () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-config-'));
    // Set by the agent's env file, not the app's own environment.
    vi.mocked(loadEnvFile).mockReturnValue({ CLAUDE_CONFIG_DIR: dir });
    const run = (purpose?: 'review') => {
      mockProc();
      const win = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() },
      } as unknown as BrowserWindow;
      const requestId = `settings-${purpose ?? 'qa'}`;
      askAboutCode(win, {
        requestId,
        channelId: 'test',
        prompt: 'Explain this code',
        cwd: '/tmp',
        provider: 'claude',
        purpose,
        envFile: '/agent.env',
      });
      cancelAskAboutCode(requestId);
      const { calls } = vi.mocked(spawn).mock;
      const [, args, options] = calls[calls.length - 1] ?? [];
      return { args: args as string[], env: (options as { env: Record<string, string> }).env };
    };
    try {
      expect(run('review').args).not.toContain('--settings');
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({
          apiKeyHelper: '/bin/key',
          env: { ANTHROPIC_BASE_URL: 'https://proxy.example' },
          hooks: { PreToolUse: [] },
          permissions: { additionalDirectories: ['/'] },
        }),
      );
      const review = run('review');
      // Hooks would run code and additionalDirectories would widen reads past the worktree.
      expect(JSON.parse(review.args[review.args.indexOf('--settings') + 1] ?? '')).toEqual({
        apiKeyHelper: '/bin/key',
      });
      // Through the environment, not argv, where a key in it would show in a process list.
      expect(review.env.ANTHROPIC_BASE_URL).toBe('https://proxy.example');
      const plain = run();
      expect(plain.args).not.toContain('--settings');
      expect(plain.env.ANTHROPIC_BASE_URL).toBeUndefined();
    } finally {
      vi.mocked(loadEnvFile).mockReturnValue({});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes the chosen reasoning level, else names the one the app shows', () => {
    const args = spawnArgs('opus', 'high');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    vi.mocked(spawn).mockClear();
    const fallback = spawnArgs('opus');
    expect(fallback[fallback.indexOf('--effort') + 1]).toBe('medium');
  });

  it('passes the chosen model to the CLI', () => {
    const args = spawnArgs('opus');
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
  });

  it('falls back to sonnet when no model is chosen', () => {
    const args = spawnArgs();
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
  });
});

describe('askCodeEnv', () => {
  afterEach(() => {
    setProjectAgentEnv('project-1', {});
    vi.mocked(loadEnvFile).mockReturnValue({});
  });

  it("layers the project's env vars over the agent env file", () => {
    vi.mocked(loadEnvFile).mockReturnValue({ CLAUDE_CONFIG_DIR: '/file', FROM_FILE: '1' });
    setProjectAgentEnv('project-1', { CLAUDE_CONFIG_DIR: '/work', PATH: '/evil' });
    const env = askCodeEnv('/agent.env', 'project-1');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/work');
    expect(env.FROM_FILE).toBe('1');
    // Blocked keys keep the app's own value, as they do for agent terminals.
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('adds nothing for an unknown or missing project', () => {
    setProjectAgentEnv('project-1', { ONLY_HERE: '1' });
    expect(askCodeEnv(undefined, 'other').ONLY_HERE).toBeUndefined();
    expect(askCodeEnv().ONLY_HERE).toBeUndefined();
  });

  it('reaches the Codex CLI too', () => {
    setProjectAgentEnv('project-1', { CODEX_HOME: '/work-codex' });
    mockProc();
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    askAboutCode(win as unknown as BrowserWindow, {
      requestId: 'codex-project-env',
      channelId: 'test',
      prompt: 'Explain this code',
      cwd: '/tmp',
      provider: 'codex',
      projectId: 'project-1',
    });
    cancelAskAboutCode('codex-project-env');
    const options = vi.mocked(spawn).mock.calls[0][2] as { env: Record<string, string> };
    expect(options.env.CODEX_HOME).toBe('/work-codex');
  });
});

describe('Codex code Q&A', () => {
  /** Each start holds a slot in the concurrency registry until it is released. */
  const started: string[] = [];
  afterEach(() => {
    for (const requestId of started.splice(0)) cancelAskAboutCode(requestId);
  });

  function start(model?: string, effort?: string) {
    const proc = mockProc();
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
    askAboutCode(win, {
      requestId: `codex-${model ?? 'default'}`,
      channelId: 'test',
      prompt: 'Explain this code',
      cwd: '/tmp',
      provider: 'codex',
      model,
      effort,
      purpose: 'understand',
    });
    started.push(`codex-${model ?? 'default'}`);
    return { proc, send, args: vi.mocked(spawn).mock.calls[0][1] as string[] };
  }

  it('runs a read-only, tool-free codex exec and sends the system prompt with the prompt on stdin', () => {
    const { proc, args } = start('gpt-5.6-luna');

    expect(vi.mocked(spawn).mock.calls[0][0]).toBe('codex');
    expect(args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      // The answer comes from the supplied context: no MCP servers, no web search.
      '-c',
      'mcp_servers={}',
      '-c',
      'tools.web_search=false',
      '-m',
      'gpt-5.6-luna',
      '-',
    ]);
    // The prompt never reaches argv, so a tour-sized diff cannot overflow it.
    expect(args).not.toContain('Explain this code');
    const written = vi.mocked(proc.stdin.end).mock.calls[0][0] as string;
    expect(written.endsWith('\n\nExplain this code')).toBe(true);
    expect(written).toContain('Return exactly one JSON object');
  });

  it('passes the reasoning level as a config override', () => {
    const { args } = start('gpt-5.6-luna', 'high');
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args[args.indexOf('model_reasoning_effort="high"') - 1]).toBe('-c');
  });

  it("names the CLI's own model when none is chosen, so the app can show which runs", () => {
    const { args } = start();
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-6-astra');
    expect(args).toContain('model_reasoning_effort="medium"');
  });

  it('turns JSONL agent messages into chunks and reports errors', () => {
    const { proc, send } = start('gpt-5.5');

    proc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"t1"}',
          '{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"First half "}}',
          'not json at all',
          '{"type":"item.completed","item":{"type":"agent_mess',
        ].join('\n'),
      ),
    );
    expect(send.mock.calls.map(([, message]) => message)).toEqual([
      { type: 'chunk', text: 'First half ' },
    ]);

    // The split line is completed by the next chunk, and the last line on close.
    proc.stdout.emit(
      'data',
      Buffer.from('age","text":"second half"}}\n{"type":"error","message":"rate limited"}'),
    );
    proc.emit('close', 0);
    expect(send.mock.calls.map(([, message]) => message)).toEqual([
      { type: 'chunk', text: 'First half ' },
      { type: 'chunk', text: 'second half' },
      { type: 'error', text: 'rate limited' },
      { type: 'done', exitCode: 0 },
    ]);
  });

  it('reports an error item and still finishes once', () => {
    const { proc, send } = start();

    proc.stdout.emit(
      'data',
      Buffer.from('{"type":"item.completed","item":{"type":"error","message":"sandbox denied"}}\n'),
    );
    proc.emit('close', 1);
    expect(send).toHaveBeenCalledWith('channel:test', {
      type: 'error',
      text: 'sandbox denied',
    });
    expect(send.mock.calls.filter(([, message]) => message.type === 'done')).toHaveLength(1);
  });
});

describe('isStructuredPurpose', () => {
  it('accepts only the JSON-schema purposes the AskAboutCode handler allows', () => {
    expect(isStructuredPurpose('tour')).toBe(true);
    expect(isStructuredPurpose('understand')).toBe(true);
    expect(isStructuredPurpose('evidence')).toBe(false);
    expect(isStructuredPurpose('task-name')).toBe(true);
    expect(isStructuredPurpose('brief')).toBe(true);
    expect(isStructuredPurpose('review')).toBe(true);
    expect(isStructuredPurpose('plan')).toBe(false);
    expect(isStructuredPurpose(undefined)).toBe(false);
  });
});
