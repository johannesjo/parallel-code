import { spawn, type ChildProcess } from 'child_process';
import type { BrowserWindow } from 'electron';
import { validateCommand, ENV_BLOCK_LIST } from './pty.js';
import { loadEnvFile } from './env-file.js';
import { ASK_CODE_MODELS, type AskCodeProvider } from '../shared/ask-code-models.js';
import {
  askCodePromptLimit,
  askCodeSystemPrompt,
  askCodeTimeoutMs,
  isStructuredPurpose,
  type AskCodePurpose,
} from './ask-code-purpose.js';
import {
  askAboutCodeMinimax,
  cancelAskAboutCodeMinimax,
  isMinimaxRequestActive,
} from './ask-code-minimax.js';
import {
  AskCodeSession,
  ASK_CODE_MAX_CONCURRENT,
  ASK_CODE_TIMEOUT_MS,
  RequestRegistry,
  assertCanStart,
  assertPromptWithinLimit,
} from './request-registry.js';

interface AskCodeRequest {
  requestId: string;
  channelId: string;
  prompt: string;
  cwd: string;
  provider?: AskCodeProvider;
  /** CLI model alias or slug; the handler validates it before it reaches argv. */
  model?: string;
  purpose?: AskCodePurpose;
  /** Reasoning level; the handler validates it against the provider's levels. */
  effort?: string;
  /** Env file configured for the agent behind the chosen provider, if any. */
  envFile?: string;
}

const activeRequests = new RequestRegistry<ChildProcess>({
  maxConcurrent: ASK_CODE_MAX_CONCURRENT,
  timeoutMs: ASK_CODE_TIMEOUT_MS,
});

/**
 * The environment an ask-code CLI runs in. It is the same CLI an agent
 * terminal runs, so it needs the same credentials — otherwise configuring an
 * env file fixes the terminals and leaves this silently broken.
 */
function askCodeEnv(envFile?: string): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) filtered[k] = v;
  }
  if (envFile?.trim()) {
    for (const [k, v] of Object.entries(loadEnvFile(envFile))) {
      if (!ENV_BLOCK_LIST.has(k)) filtered[k] = v;
    }
  }
  // Clear env vars that prevent nested agent sessions
  delete filtered.CLAUDECODE;
  delete filtered.CLAUDE_CODE_SESSION;
  delete filtered.CLAUDE_CODE_ENTRYPOINT;
  return filtered;
}

export function askAboutCode(win: BrowserWindow, args: AskCodeRequest): void {
  const { requestId, channelId, prompt, cwd, provider, envFile } = args;

  // Route to MiniMax backend when configured
  if (provider === 'minimax') {
    activeRequests.cancel(requestId);
    askAboutCodeMinimax(win, { requestId, channelId, prompt, purpose: args.purpose });
    return;
  }

  // Structured purposes (tours) pipe their prompt over stdin and answer with JSON.
  const isStructured = isStructuredPurpose(args.purpose);
  assertPromptWithinLimit(prompt, askCodePromptLimit(args.purpose));
  assertCanStart(activeRequests, requestId);

  // Cancel any existing request with the same ID
  cancelAskAboutCode(requestId);

  const sendToChannel = (msg: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(`channel:${channelId}`, msg);
  };

  if (provider === 'codex') {
    askAboutCodeCodex(args, sendToChannel);
    return;
  }

  validateCommand('claude');

  const proc = spawn(
    'claude',
    [
      '-p',
      ...(isStructured ? [] : [prompt]),
      '--output-format',
      'text',
      '--model',
      args.model ?? ASK_CODE_MODELS.claude,
      ...(args.effort ? ['--effort', args.effort] : []),
      // Empty string disables all tool usage for quick Q&A responses
      '--tools',
      '',
      '--no-session-persistence',
      '--append-system-prompt',
      askCodeSystemPrompt(args.purpose),
    ],
    {
      cwd,
      env: askCodeEnv(envFile),
      stdio: [isStructured ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    },
  );

  const send = sendToChannel;

  const session = AskCodeSession.start(
    activeRequests,
    requestId,
    proc,
    send,
    (request) => request.kill('SIGTERM'),
    askCodeTimeoutMs(args.purpose),
  );

  proc.stdout?.on('data', (chunk: Buffer) => {
    send({ type: 'chunk', text: chunk.toString('utf8') });
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    send({ type: 'error', text: chunk.toString('utf8') });
  });

  proc.on('close', (code) => {
    session.cleanup();
    if (session.complete()) {
      send({ type: 'done', exitCode: code });
    }
  });

  proc.on('error', (err) => {
    session.cleanup();
    if (session.complete()) {
      send({ type: 'error', text: err.message });
      send({ type: 'done', exitCode: 1 });
    }
  });

  if (isStructured) {
    // Large diffs exceed OS argument-size limits; Claude supports piped input.
    proc.stdin?.on('error', (err: Error) => {
      if (!session.complete()) return;
      session.cleanup();
      send({ type: 'error', text: `Could not send tour prompt: ${err.message}` });
      send({ type: 'done', exitCode: 1 });
      proc.kill('SIGTERM');
    });
    proc.stdin?.end(prompt);
  }
}

type ChannelMessage = { type: 'chunk' | 'error'; text: string };

/**
 * `codex exec --json` speaks JSONL: one event per line, and only the agent's
 * own message and its errors matter for a code answer. Lines that are not JSON
 * are progress chatter and are dropped. Kept local on purpose — the documents
 * parser next door reports tool activity this caller has no use for.
 */
class CodexJsonl {
  private partial = '';

  push(chunk: string): ChannelMessage[] {
    const lines = (this.partial + chunk).split('\n');
    this.partial = lines.pop() ?? '';
    return lines.flatMap((line) => this.event(line));
  }

  /** The last line of output has no trailing newline, so it is parsed on close. */
  flush(): ChannelMessage[] {
    const rest = this.partial;
    this.partial = '';
    return this.event(rest);
  }

  private event(line: string): ChannelMessage[] {
    if (!line.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    if (typeof parsed !== 'object' || parsed === null) return [];
    const event = parsed as Record<string, unknown>;
    if (event.type === 'error') return [{ type: 'error', text: asText(event.message) }];
    if (event.type !== 'item.completed') return [];
    const item = (event.item ?? {}) as Record<string, unknown>;
    if (item.type === 'error') return [{ type: 'error', text: asText(item.message) }];
    if (item.type !== 'agent_message') return [];
    const text = typeof item.text === 'string' ? item.text : '';
    return text ? [{ type: 'chunk', text }] : [];
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' && value ? value : 'The Codex CLI reported an error.';
}

/**
 * Codex has no `--append-system-prompt`, so the system prompt is prepended to
 * the prompt itself. Both halves go over stdin (`-`), which keeps a large tour
 * diff clear of the OS argument-size limit.
 *
 * An answer must come from the context the app supplied, the way `--tools ''`
 * keeps the Claude CLI to it, so the configured MCP servers and web search are
 * switched off. shortcut: Codex has no flag for its own shell tool, so the
 * read-only sandbox is the ceiling here — drop the tool itself once the CLI
 * supports it.
 */
function askAboutCodeCodex(args: AskCodeRequest, send: (msg: unknown) => void): void {
  validateCommand('codex');
  const proc = spawn(
    'codex',
    [
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '-c',
      'mcp_servers={}',
      '-c',
      'tools.web_search=false',
      ...(args.model ? ['-m', args.model] : []),
      // Codex has no effort flag; the config override takes a TOML value.
      ...(args.effort ? ['-c', `model_reasoning_effort="${args.effort}"`] : []),
      '-',
    ],
    { cwd: args.cwd, env: askCodeEnv(args.envFile), stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const session = AskCodeSession.start(
    activeRequests,
    args.requestId,
    proc,
    send,
    (request) => request.kill('SIGTERM'),
    askCodeTimeoutMs(args.purpose),
  );
  const parser = new CodexJsonl();

  proc.stdout?.on('data', (chunk: Buffer) => {
    for (const message of parser.push(chunk.toString('utf8'))) send(message);
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    send({ type: 'error', text: chunk.toString('utf8') });
  });

  proc.on('close', (code) => {
    for (const message of parser.flush()) send(message);
    session.cleanup();
    if (session.complete()) send({ type: 'done', exitCode: code });
  });

  proc.on('error', (err) => {
    session.cleanup();
    if (session.complete()) {
      send({ type: 'error', text: err.message });
      send({ type: 'done', exitCode: 1 });
    }
  });

  proc.stdin?.on('error', (err: Error) => {
    if (!session.complete()) return;
    session.cleanup();
    send({ type: 'error', text: `Could not send the prompt to Codex: ${err.message}` });
    send({ type: 'done', exitCode: 1 });
    proc.kill('SIGTERM');
  });
  proc.stdin?.end(`${askCodeSystemPrompt(args.purpose)}\n\n${args.prompt}`);
}

export function cancelAskAboutCode(requestId: string): void {
  if (isMinimaxRequestActive(requestId)) {
    cancelAskAboutCodeMinimax(requestId);
  }

  activeRequests.cancel(requestId);
}
