import { spawn, type ChildProcess } from 'child_process';
import type { BrowserWindow } from 'electron';
import { validateCommand } from './pty.js';

interface AskCodeRequest {
  requestId: string;
  channelId: string;
  prompt: string;
  cwd: string;
}

const MAX_PROMPT_LENGTH = 50_000;
const MAX_CONCURRENT = 5;
const TIMEOUT_MS = 120_000;

const activeRequests = new Map<string, ChildProcess>();
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function askAboutCode(win: BrowserWindow, args: AskCodeRequest): void {
  const { requestId, channelId, prompt, cwd } = args;

  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Prompt too long (${prompt.length} chars, max ${MAX_PROMPT_LENGTH})`);
  }
  if (activeRequests.size >= MAX_CONCURRENT) {
    throw new Error('Too many concurrent ask-about-code requests');
  }

  // Cancel any existing request with the same ID
  cancelAskAboutCode(requestId);

  validateCommand('claude');

  const filteredEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) filteredEnv[k] = v;
  }
  // Clear env vars that prevent nested agent sessions
  delete filteredEnv.CLAUDECODE;
  delete filteredEnv.CLAUDE_CODE_SESSION;
  delete filteredEnv.CLAUDE_CODE_ENTRYPOINT;

  const proc = spawn(
    'claude',
    [
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
    ],
    {
      cwd,
      env: filteredEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  activeRequests.set(requestId, proc);

  const send = (msg: unknown) => {
    if (!win.isDestroyed()) {
      win.webContents.send(`channel:${channelId}`, msg);
    }
  };

  let finished = false;

  function cleanup() {
    activeRequests.delete(requestId);
    const timer = activeTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      activeTimers.delete(requestId);
    }
  }

  proc.stdout?.on('data', (chunk: Buffer) => {
    send({ type: 'chunk', text: chunk.toString('utf8') });
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    send({ type: 'error', text: chunk.toString('utf8') });
  });

  proc.on('close', (code) => {
    cleanup();
    if (!finished) {
      finished = true;
      send({ type: 'done', exitCode: code });
    }
  });

  proc.on('error', (err) => {
    cleanup();
    if (!finished) {
      finished = true;
      send({ type: 'error', text: err.message });
      send({ type: 'done', exitCode: 1 });
    }
  });

  // Safety timeout: kill after 2 minutes.
  // Set finished BEFORE cancel to prevent the async close handler from
  // also sending a done message (race between timeout and process exit).
  const timer = setTimeout(() => {
    activeTimers.delete(requestId);
    if (activeRequests.has(requestId)) {
      finished = true;
      send({ type: 'error', text: 'Request timed out after 2 minutes.' });
      cancelAskAboutCode(requestId);
      send({ type: 'done', exitCode: 1 });
    }
  }, TIMEOUT_MS);
  activeTimers.set(requestId, timer);
}

export function cancelAskAboutCode(requestId: string): void {
  const proc = activeRequests.get(requestId);
  if (proc) {
    proc.kill('SIGTERM');
    activeRequests.delete(requestId);
  }
  const timer = activeTimers.get(requestId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(requestId);
  }
}
