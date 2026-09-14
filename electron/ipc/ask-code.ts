import { spawn, type ChildProcess } from 'child_process';
import type { BrowserWindow } from 'electron';
import { validateCommand, ENV_BLOCK_LIST } from './pty.js';
import { resolveCommand, windowsPtyCommand } from '../command-path.js';
import { killProcessTree } from '../process-tree.js';
import { loadEnvFile } from './env-file.js';
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

export type AskCodeProvider = 'claude' | 'minimax';

interface AskCodeRequest {
  requestId: string;
  channelId: string;
  prompt: string;
  cwd: string;
  provider?: AskCodeProvider;
  /** Env file configured for the Claude Code agent, if any. */
  envFile?: string;
}

const activeRequests = new RequestRegistry<ChildProcess>({
  maxConcurrent: ASK_CODE_MAX_CONCURRENT,
  timeoutMs: ASK_CODE_TIMEOUT_MS,
});

export function askAboutCode(win: BrowserWindow, args: AskCodeRequest): void {
  const { requestId, channelId, prompt, cwd, provider, envFile } = args;

  // Route to MiniMax backend when configured
  if (provider === 'minimax') {
    activeRequests.cancel(requestId);
    askAboutCodeMinimax(win, { requestId, channelId, prompt });
    return;
  }

  assertPromptWithinLimit(prompt);
  assertCanStart(activeRequests, requestId);

  // Cancel any existing request with the same ID
  cancelAskAboutCode(requestId);

  validateCommand('claude');

  const filteredEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) filteredEnv[k] = v;
  }
  // Ask Code runs the same `claude` CLI as an agent terminal, so it needs the
  // same credentials — otherwise configuring an env file fixes the terminals
  // and leaves this silently broken.
  if (envFile?.trim()) {
    for (const [k, v] of Object.entries(loadEnvFile(envFile))) {
      if (!ENV_BLOCK_LIST.has(k)) filteredEnv[k] = v;
    }
  }
  // Clear env vars that prevent nested agent sessions
  delete filteredEnv.CLAUDECODE;
  delete filteredEnv.CLAUDE_CODE_SESSION;
  delete filteredEnv.CLAUDE_CODE_ENTRYPOINT;

  const launch = process.platform === 'win32'
    ? windowsPtyCommand(resolveCommand('claude'), [
      '-p',
      prompt,
      '--output-format',
      'text',
      '--model',
      'sonnet',
      // Empty string disables all tool usage for quick Q&A responses
      '--tools',
      '',
      '--no-session-persistence',
      '--append-system-prompt',
      'Answer concisely about the selected code. Use markdown.',
    ])
    : { command: resolveCommand('claude'), args: [
      '-p', prompt, '--output-format', 'text', '--model', 'sonnet', '--tools', '',
      '--no-session-persistence', '--append-system-prompt',
      'Answer concisely about the selected code. Use markdown.',
    ] };
  const proc = spawn(launch.command, launch.args, {
      cwd,
      env: filteredEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
  });

  const send = (msg: unknown) => {
    if (!win.isDestroyed()) {
      win.webContents.send(`channel:${channelId}`, msg);
    }
  };

  const session = AskCodeSession.start(activeRequests, requestId, proc, send, (request) =>
    killProcessTree(request),
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
}

export function cancelAskAboutCode(requestId: string): void {
  if (isMinimaxRequestActive(requestId)) {
    cancelAskAboutCodeMinimax(requestId);
  }

  activeRequests.cancel(requestId);
}
