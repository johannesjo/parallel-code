import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { resolveUserShell } from '../user-shell.js';
import { stripAnsi } from '../shared/prompt-detect.js';

/**
 * Per-project worktree setup and teardown scripts.
 *
 * Both live in app state, never in a repo file, for the same reason as the
 * verify command: opening a hostile clone must not run commands on the host.
 * Setup runs in a visible task terminal (the PTY path in `pty.ts`); teardown
 * runs here, headless, while the task shows its closing state.
 */

export const WORKTREE_SCRIPT_MAX_LENGTH = 16 * 1024;
export const TEARDOWN_TIMEOUT_MS = 2 * 60_000;
export const TEARDOWN_OUTPUT_TAIL_CHARS = 8 * 1024;
/** Lines of output quoted in the failure notice; the rest is in the log tail. */
const FAILURE_EXCERPT_LINES = 6;
const KILL_GRACE_MS = 3_000;

/** Shells that understand `-e -c <script>` with POSIX semantics. */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash']);

export function validateWorktreeScript(script: unknown, label: string): asserts script is string {
  if (typeof script !== 'string' || !script.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (script.length > WORKTREE_SCRIPT_MAX_LENGTH) {
    throw new Error(`${label} too long (max ${WORKTREE_SCRIPT_MAX_LENGTH} chars)`);
  }
  if (script.includes('\0')) throw new Error(`${label} must not contain NUL characters`);
}

/** Normalised script text, or undefined when the value means "no script". */
export function optionalWorktreeScript(script: unknown, label: string): string | undefined {
  if (script === undefined || script === null) return undefined;
  if (typeof script === 'string' && !script.trim()) return undefined;
  validateWorktreeScript(script, label);
  return script;
}

export interface ScriptInvocation {
  file: string;
  args: string[];
  /** cmd.exe parses its own command line: pass `args` through unquoted. */
  windowsVerbatimArguments?: boolean;
}

interface InvocationOptions {
  platform?: NodeJS.Platform;
  /** The user's shell; resolved when omitted. */
  shell?: string;
  /** Docker tasks run inside the container, where only `/bin/sh` is certain. */
  docker?: boolean;
}

function shellKind(shell: string): 'posix' | 'cmd' | 'powershell' | 'other' {
  const base = path
    .basename(shell.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (POSIX_SHELLS.has(base)) return 'posix';
  if (base === 'cmd') return 'cmd';
  if (base === 'powershell' || base === 'pwsh') return 'powershell';
  return 'other';
}

function scriptLines(script: string): string[] {
  return script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * How to run a multi-line script so it stops at the first failing command,
 * whatever shell the user has. POSIX shells get `-e`; a non-POSIX login
 * shell (fish, nu, …) falls back to `/bin/sh`, so the script's syntax does
 * not depend on the login shell. On Windows, cmd.exe chains the lines with
 * `&&` and PowerShell stops on errors, including native exit codes.
 */
export function buildScriptInvocation(
  script: string,
  options: InvocationOptions = {},
): ScriptInvocation {
  const platform = options.platform ?? process.platform;
  if (options.docker) return { file: '/bin/sh', args: ['-e', '-c', script] };
  const shell = options.shell ?? resolveUserShell({ platform });
  const kind = shellKind(shell);

  if (platform !== 'win32') {
    return { file: kind === 'posix' ? shell : '/bin/sh', args: ['-e', '-c', script] };
  }
  if (kind === 'posix') return { file: shell, args: ['-e', '-c', script] };
  if (kind === 'powershell') {
    const prelude =
      "$ErrorActionPreference = 'Stop'; $PSNativeCommandUseErrorActionPreference = $true";
    return {
      file: shell,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${prelude}\n${script}`],
    };
  }
  // cmd.exe (also the fallback for anything else on Windows): one command line,
  // `/s` strips exactly the outer quotes so inner quotes survive.
  return {
    file: kind === 'cmd' ? shell : 'cmd.exe',
    args: ['/d', '/s', '/c', `"${scriptLines(script).join(' && ')}"`],
    windowsVerbatimArguments: true,
  };
}

/** Variables setup and teardown scripts can use, e.g. to copy from the main checkout. */
export function buildWorktreeScriptEnv(args: {
  projectRoot: string;
  worktreePath: string;
  branchName?: string;
  taskId?: string;
}): Record<string, string> {
  return {
    PARALLEL_CODE_ROOT_PATH: args.projectRoot,
    PARALLEL_CODE_WORKTREE: args.worktreePath,
    PARALLEL_CODE_BRANCH: args.branchName ?? '',
    PARALLEL_CODE_TASK_ID: args.taskId ?? '',
  };
}

export type TeardownStatus = 'passed' | 'failed' | 'timed_out' | 'error' | 'skipped';

export interface TeardownResult {
  status: TeardownStatus;
  exitCode: number | null;
  outputTail: string;
  message?: string;
}

export interface TeardownRequest {
  worktreePath: string;
  /** Main checkout. Teardown never runs there, even if a caller mixes them up. */
  projectRoot: string;
  script: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface TeardownDeps {
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
  shell?: string;
}

function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function appendTail(tail: string, chunk: string): string {
  const next = tail + chunk;
  return next.length > TEARDOWN_OUTPUT_TAIL_CHARS ? next.slice(-TEARDOWN_OUTPUT_TAIL_CHARS) : next;
}

/** Runs the teardown script in the worktree and reports how it ended. Never throws. */
export function runTeardownScript(
  request: TeardownRequest,
  deps: TeardownDeps = {},
): Promise<TeardownResult> {
  const skipped = (message: string): Promise<TeardownResult> =>
    Promise.resolve({ status: 'skipped', exitCode: null, outputTail: '', message });
  if (!fs.existsSync(request.worktreePath)) return skipped('The worktree no longer exists.');
  if (realpathOrResolve(request.worktreePath) === realpathOrResolve(request.projectRoot)) {
    return skipped('Teardown never runs in the main checkout.');
  }

  const platform = deps.platform ?? process.platform;
  const invocation = buildScriptInvocation(request.script, { platform, shell: deps.shell });
  const spawnImpl = deps.spawnImpl ?? spawn;
  const timeoutMs = request.timeoutMs ?? TEARDOWN_TIMEOUT_MS;

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(invocation.file, invocation.args, {
        cwd: request.worktreePath,
        env: { ...process.env, ...request.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
    } catch (err) {
      resolve({
        status: 'error',
        exitCode: null,
        outputTail: '',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let outputTail = '';
    let settled = false;
    let timedOut = false;
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      const hardKill = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
      hardKill.unref?.();
    }, timeoutMs);
    const finish = (result: TeardownResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const onChunk = (buf: Buffer) => {
      outputTail = appendTail(outputTail, stripAnsi(buf.toString('utf8')));
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) =>
      finish({ status: 'error', exitCode: null, outputTail, message: err.message }),
    );
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({
          status: 'timed_out',
          exitCode: code,
          outputTail,
          message: `timed out after ${Math.round(timeoutMs / 1000)} s`,
        });
      } else if (code === 0) {
        finish({ status: 'passed', exitCode: 0, outputTail });
      } else {
        finish({
          status: 'failed',
          exitCode: code,
          outputTail,
          ...(signal ? { message: `Killed by ${signal}.` } : {}),
        });
      }
    });
  });
}

/**
 * A one-paragraph notice for a teardown that did not pass, quoting the last
 * lines of output, or undefined when there is nothing to report.
 */
export function describeTeardownFailure(result: TeardownResult): string | undefined {
  if (result.status === 'passed' || result.status === 'skipped') return undefined;
  const how =
    result.status === 'timed_out'
      ? (result.message ?? 'timed out')
      : result.status === 'error'
        ? `could not start: ${result.message ?? 'unknown error'}`
        : `exited with code ${result.exitCode ?? '?'}${result.message ? ` (${result.message})` : ''}`;
  const excerpt = result.outputTail
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-FAILURE_EXCERPT_LINES)
    .join('\n');
  return `Teardown script ${how}.${excerpt ? `\n${excerpt}` : ''}`;
}
