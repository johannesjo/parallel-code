import { spawn } from 'child_process';
import type { BrowserWindow } from 'electron';

// One AbortController per active setup/teardown channel. cancelProjectCommands
// aborts it; spawn({signal}) kills the child; close handler detects the abort
// via signal.aborted.
const controllers = new Map<string, AbortController>();

// Electron / Node internal env that must not leak into user shell commands.
// `NODE_OPTIONS=--inspect-brk` would silently open a debugger for `npm install`;
// `ELECTRON_RUN_AS_NODE=1` mis-directs child `node` processes; `LD_PRELOAD`
// is a common ptrace/injection hook and has no business in user scripts.
const STRIP_ENV_KEYS = [
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_DEFAULT_ERROR_MODE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING',
  'LD_PRELOAD',
];

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const stripped = new Set<string>(STRIP_ENV_KEYS);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!stripped.has(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

interface RunCommandsArgs {
  worktreePath: string;
  projectRoot: string;
  commands: string[];
  channelId: string;
}

/**
 * Run a sequence of shell commands for setup or teardown. Aborts on the first
 * non-zero exit or when the channel is cancelled.
 *
 * `$PROJECT_ROOT` and `$WORKTREE` are exposed as env vars rather than
 * interpolated into the command string — this avoids shell-metacharacter
 * injection when a path contains spaces, semicolons, or backticks.
 */
export async function runProjectCommands(win: BrowserWindow, args: RunCommandsArgs): Promise<void> {
  const { worktreePath, projectRoot, commands, channelId } = args;

  const controller = new AbortController();
  controllers.set(channelId, controller);

  const send = (msg: string) => {
    if (!win.isDestroyed()) {
      win.webContents.send(`channel:${channelId}`, msg);
    }
  };

  try {
    for (const cmd of commands) {
      controller.signal.throwIfAborted();
      send(`$ ${cmd}\n`);
      await runOne(cmd, worktreePath, projectRoot, controller.signal, send);
    }
  } finally {
    if (controllers.get(channelId) === controller) {
      controllers.delete(channelId);
    }
  }
}

function runOne(
  cmd: string,
  cwd: string,
  projectRoot: string,
  signal: AbortSignal,
  send: (msg: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('sh', ['-c', cmd], {
      cwd,
      env: cleanEnv({ PROJECT_ROOT: projectRoot, WORKTREE: cwd }),
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });

    proc.stdout?.on('data', (c: Buffer) => send(c.toString('utf8')));
    proc.stderr?.on('data', (c: Buffer) => send(c.toString('utf8')));

    let settled = false;
    proc.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      if (signal.aborted) {
        // Raise a typed AbortError so callers can distinguish cancellation
        // from a genuine failure without string-matching.
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      } else if (code === 0) {
        resolve();
      } else if (sig) {
        reject(new Error(`Command "${cmd}" killed by ${sig}`));
      } else {
        reject(new Error(`Command "${cmd}" exited with code ${code}`));
      }
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** Abort the running command for this channel, if any. */
export function cancelProjectCommands(channelId: string): void {
  controllers.get(channelId)?.abort();
}
