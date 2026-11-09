import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
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
/** How long output may keep arriving after the script exits. */
const EXIT_DRAIN_MS = 500;

/** Shells that understand `-e -c <script>` with POSIX semantics. */
const execFileAsync = promisify(execFile);

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

/**
 * Variables setup and teardown scripts can use, e.g. to copy from the main
 * checkout. No task id: `PARALLEL_CODE_TASK_ID` is the agent-hook identity,
 * which the PTY layer strips and child processes must not inherit.
 */
export function buildWorktreeScriptEnv(args: {
  projectRoot: string;
  worktreePath: string;
  branchName?: string;
}): Record<string, string> {
  return {
    PARALLEL_CODE_ROOT_PATH: args.projectRoot,
    PARALLEL_CODE_WORKTREE: args.worktreePath,
    PARALLEL_CODE_BRANCH: args.branchName ?? '',
  };
}

/** Linked worktrees of a repository (the main checkout excluded), as real paths. */
export async function listLinkedWorktrees(projectRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
    cwd: projectRoot,
    maxBuffer: 8 * 1024 * 1024,
  });
  const paths = String(stdout)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => realpathOrResolve(line.slice('worktree '.length)));
  // The first entry is always the main working tree.
  return paths.slice(1);
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
  /** Defaults to `git worktree list`; teardown only runs in a listed worktree. */
  listWorktrees?: (projectRoot: string) => Promise<string[]>;
}

/**
 * Canonical form for comparing paths. The native realpath expands Windows
 * 8.3 short names (`RUNNER~1`), which git never prints and the JS realpath
 * keeps; Windows paths also compare without regard to case.
 */
function realpathOrResolve(p: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(p);
  } catch {
    resolved = path.resolve(p);
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function appendTail(tail: string, chunk: string): string {
  const next = tail + chunk;
  return next.length > TEARDOWN_OUTPUT_TAIL_CHARS ? next.slice(-TEARDOWN_OUTPUT_TAIL_CHARS) : next;
}

/** Runs the teardown script in the worktree and reports how it ended. Never throws. */
export async function runTeardownScript(
  request: TeardownRequest,
  deps: TeardownDeps = {},
): Promise<TeardownResult> {
  const skipped = (message: string): TeardownResult => ({
    status: 'skipped',
    exitCode: null,
    outputTail: '',
    message,
  });
  if (!fs.existsSync(request.worktreePath)) return skipped('The worktree no longer exists.');
  const target = realpathOrResolve(request.worktreePath);
  if (target === realpathOrResolve(request.projectRoot)) {
    return skipped('Teardown never runs in the main checkout.');
  }
  // A path the renderer sent is only trusted once git confirms it is one of
  // this repository's linked worktrees, so a stale or mistaken path can never
  // run the script in an unrelated folder.
  let linked: string[];
  try {
    linked = await (deps.listWorktrees ?? listLinkedWorktrees)(request.projectRoot);
  } catch (err) {
    return {
      status: 'error',
      exitCode: null,
      outputTail: '',
      message: `could not list worktrees: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!linked.includes(target)) {
    return {
      status: 'error',
      exitCode: null,
      outputTail: '',
      message: `${request.worktreePath} is not a worktree of this repository, so it was not run`,
    };
  }
  return spawnTeardown(request, deps);
}

function spawnTeardown(request: TeardownRequest, deps: TeardownDeps): Promise<TeardownResult> {
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
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      timers.push(t);
    };
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (!child.pid) child.kill(signal);
        else if (platform === 'win32')
          // child.kill() would stop cmd.exe alone and leave e.g. docker running.
          spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          }).on('error', () => undefined);
        else process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };
    const finish = (result: TeardownResult) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      // A grandchild may still hold the pipes; never wait on it.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };
    const outcome = (code: number | null, signal: NodeJS.Signals | null): TeardownResult => {
      if (timedOut)
        return {
          status: 'timed_out',
          exitCode: code,
          outputTail,
          message: `timed out after ${Math.round(timeoutMs / 1000)} s`,
        };
      if (code === 0 && !signal) return { status: 'passed', exitCode: 0, outputTail };
      return {
        status: 'failed',
        exitCode: code,
        outputTail,
        ...(signal ? { message: `killed by ${signal}` } : {}),
      };
    };
    later(timeoutMs, () => {
      timedOut = true;
      killTree('SIGTERM');
      later(KILL_GRACE_MS, () => killTree('SIGKILL'));
      // Even if nothing ever reports an exit, the close or merge goes on.
      later(KILL_GRACE_MS * 2, () => finish(outcome(null, null)));
    });
    const onChunk = (buf: Buffer) => {
      outputTail = appendTail(outputTail, stripAnsi(buf.toString('utf8')));
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) =>
      finish({ status: 'error', exitCode: null, outputTail, message: err.message }),
    );
    // 'close' waits for every holder of the pipes, including a backgrounded
    // grandchild; 'exit' is the script itself. Give the output a moment to
    // drain after 'exit', then settle without waiting for stragglers.
    child.on('close', (code, signal) => finish(outcome(code, signal)));
    child.on('exit', (code, signal) => later(EXIT_DRAIN_MS, () => finish(outcome(code, signal))));
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
        : result.exitCode === null && result.message
          ? `was ${result.message}`
          : `exited with code ${result.exitCode ?? '?'}${result.message ? ` (${result.message})` : ''}`;
  const excerpt = result.outputTail
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-FAILURE_EXCERPT_LINES)
    .join('\n');
  return `Teardown script ${how}.${excerpt ? `\n${excerpt}` : ''}`;
}
