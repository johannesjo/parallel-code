import { execFile, spawn } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';
import { resolveUserShell } from '../user-shell.js';
import { stripAnsi } from '../shared/prompt-detect.js';
import { pendingVerificationRun } from '../shared/verification-run.js';
import type { VerificationRun, VerificationRunStatus } from './shared-types.js';

export const VERIFY_TIMEOUT_MS = 10 * 60_000;
/** Ten tasks must not run ten test suites at once; extra runs wait in FIFO order. */
export const VERIFY_MAX_CONCURRENT = 2;
export const VERIFY_OUTPUT_TAIL_CHARS = 32 * 1024;
export const VERIFY_COMMAND_MAX_LENGTH = 4096;
const KILL_GRACE_MS = 3_000;

export interface VerifyRequest {
  /** Cancel handle and "one run per task" key: starting a run with a key that
   *  is already running cancels the older run first. */
  key: string;
  worktreePath: string;
  command: string;
  /** Extra variables visible to the command (task id, branch, …). */
  env?: Record<string, string>;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}

export interface VerifyRunnerDeps {
  spawnImpl?: typeof spawn;
  execFileImpl?: typeof execFile;
  shell?: string;
  maxConcurrent?: number;
}

export interface VerificationRunner {
  start(request: VerifyRequest): Promise<VerificationRun>;
  cancel(key: string): boolean;
  /** Stops every running and queued run, e.g. when the app quits. */
  cancelAll(): void;
  isRunning(key: string): boolean;
}

interface GitSnapshot {
  headSha: string | null;
  dirty: boolean;
}

/** How the command ended; merged with the git snapshot into the final run. */
interface RunOutcome {
  status: VerificationRunStatus;
  exitCode: number | null;
  outputTail: string;
  message?: string;
}

type EndReason = Pick<RunOutcome, 'status' | 'message'>;
type SpawnDeps = Required<Pick<VerifyRunnerDeps, 'spawnImpl' | 'shell'>>;
type Child = ReturnType<typeof spawn>;

/** Variables a verify command can use to namespace shared resources such as a
 *  database name or a port, so parallel worktrees don't collide. */
export function buildVerifyEnv(args: {
  taskId: string;
  branchName?: string;
  worktreePath: string;
}): Record<string, string> {
  return {
    PARALLEL_CODE_TASK_ID: args.taskId,
    PARALLEL_CODE_BRANCH: args.branchName ?? '',
    PARALLEL_CODE_WORKTREE: args.worktreePath,
  };
}

export function validateVerifyCommand(command: unknown): asserts command is string {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('verify command must be a non-empty string');
  }
  if (command.length > VERIFY_COMMAND_MAX_LENGTH) {
    throw new Error(`verify command too long (max ${VERIFY_COMMAND_MAX_LENGTH} chars)`);
  }
}

async function snapshotGitState(
  worktreePath: string,
  execFileImpl: typeof execFile,
): Promise<GitSnapshot> {
  const exec = promisify(execFileImpl);
  const git = (args: string[]): Promise<string | null> =>
    exec('git', args, { cwd: worktreePath, maxBuffer: 8 * 1024 * 1024 }).then(
      (result) => String(result.stdout).trim(),
      () => null,
    );
  const [head, status] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['status', '--porcelain']),
  ]);
  // No HEAD means no checkout (gitIsolation 'none') or no git: the run still
  // happens, it just can't be pinned. A status failure on its own (index.lock
  // while the agent commits) keeps the pin and counts as dirty, not clean.
  const headSha = head || null;
  return { headSha, dirty: status === null ? headSha !== null : status.length > 0 };
}

function appendTail(tail: string, chunk: string): string {
  const next = tail + chunk;
  return next.length > VERIFY_OUTPUT_TAIL_CHARS ? next.slice(-VERIFY_OUTPUT_TAIL_CHARS) : next;
}

function killProcessTree(child: Child): void {
  const pid = child.pid;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      if (pid && process.platform !== 'win32') process.kill(-pid, signal);
      else child.kill(signal);
    } catch {
      /* already gone */
    }
  };
  signalGroup('SIGTERM');
  const hardKill = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
  hardKill.unref?.();
  child.once('close', () => clearTimeout(hardKill));
}

function formatTimeout(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

function exitOutcome(code: number | null, signal: NodeJS.Signals | null): EndReason {
  if (code === 0) return { status: 'passed' };
  return { status: 'failed', ...(signal ? { message: `Killed by ${signal}.` } : {}) };
}

function spawnCommand(request: VerifyRequest, deps: SpawnDeps): Child {
  return deps.spawnImpl(deps.shell, ['-c', request.command], {
    cwd: request.worktreePath,
    env: { ...process.env, ...request.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so `npm test` and every child it forks die together.
    detached: process.platform !== 'win32',
  });
}

/** Streams output and settles once the child exits, is cancelled, or times out. */
function watchCommand(
  child: Child,
  request: VerifyRequest,
  signal: AbortSignal,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let outputTail = '';
    let settled = false;
    // Recorded before the kill so the close handler can name the reason.
    let killed: EndReason | null = null;
    const kill = (reason: EndReason) => {
      killed = reason;
      killProcessTree(child);
    };
    const timeoutMs = request.timeoutMs ?? VERIFY_TIMEOUT_MS;
    const timeout = setTimeout(
      () => kill({ status: 'timed_out', message: `Timed out after ${formatTimeout(timeoutMs)}.` }),
      timeoutMs,
    );
    const onAbort = () => kill({ status: 'cancelled', message: 'Cancelled.' });
    const finish = (exitCode: number | null, reason: EndReason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve({ ...reason, exitCode, outputTail });
    };
    const onChunk = (buf: Buffer) => {
      const text = stripAnsi(buf.toString('utf8'));
      outputTail = appendTail(outputTail, text);
      request.onOutput?.(text);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => finish(null, { status: 'error', message: err.message }));
    child.on('close', (code, sig) => finish(code, killed ?? exitOutcome(code, sig)));
  });
}

function failedToStart(message: string): RunOutcome {
  return { status: 'error', exitCode: null, outputTail: '', message };
}

function runCommand(
  request: VerifyRequest,
  signal: AbortSignal,
  deps: SpawnDeps,
): Promise<RunOutcome> {
  // Spawning in a missing cwd reports ENOENT for the shell, which misleads.
  if (!existsSync(request.worktreePath)) {
    return Promise.resolve(failedToStart(`Worktree directory is missing: ${request.worktreePath}`));
  }
  let child: Child;
  try {
    child = spawnCommand(request, deps);
  } catch (err) {
    // Node throws synchronously for e.g. ENOTDIR or E2BIG; the rest arrive as
    // 'error' events and are handled in watchCommand.
    return Promise.resolve(failedToStart(err instanceof Error ? err.message : String(err)));
  }
  return watchCommand(child, request, signal);
}

async function execute(
  request: VerifyRequest,
  signal: AbortSignal,
  deps: SpawnDeps & { execFileImpl: typeof execFile },
): Promise<VerificationRun> {
  const startedAt = new Date().toISOString();
  const snapshot = await snapshotGitState(request.worktreePath, deps.execFileImpl);
  const outcome = await runCommand(request, signal, deps);
  return {
    command: request.command,
    ...snapshot,
    startedAt,
    ...outcome,
    finishedAt: new Date().toISOString(),
  };
}

export function createVerificationRunner(deps: VerifyRunnerDeps = {}): VerificationRunner {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const execFileImpl = deps.execFileImpl ?? execFile;
  const maxConcurrent = deps.maxConcurrent ?? VERIFY_MAX_CONCURRENT;
  const active = new Map<string, AbortController>();
  const waiting: Array<() => void> = [];
  let inFlight = 0;

  const acquireSlot = (signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('cancelled'));
      if (signal.aborted) {
        onAbort();
        return;
      }
      if (inFlight < maxConcurrent) {
        inFlight += 1;
        resolve();
        return;
      }
      // Settle at once on cancel rather than when a slot frees up, which can
      // be a full timeout away; the stale waiter is skipped when its turn comes.
      signal.addEventListener('abort', onAbort, { once: true });
      waiting.push(() => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) return;
        inFlight += 1;
        resolve();
      });
    });

  const releaseSlot = (): void => {
    inFlight -= 1;
    while (waiting.length > 0 && inFlight < maxConcurrent) waiting.shift()?.();
  };

  const cancel = (key: string): boolean => {
    const controller = active.get(key);
    if (!controller) return false;
    active.delete(key);
    controller.abort();
    return true;
  };

  const start = async (request: VerifyRequest): Promise<VerificationRun> => {
    cancel(request.key);
    const controller = new AbortController();
    active.set(request.key, controller);
    const shell = deps.shell ?? resolveUserShell();
    const pending = pendingVerificationRun(request.command);
    try {
      await acquireSlot(controller.signal);
    } catch {
      return {
        ...pending,
        status: 'cancelled',
        finishedAt: new Date().toISOString(),
        message: 'Cancelled before it started.',
      };
    }
    try {
      return await execute(request, controller.signal, { spawnImpl, execFileImpl, shell });
    } finally {
      releaseSlot();
      if (active.get(request.key) === controller) active.delete(request.key);
    }
  };

  const cancelAll = (): void => {
    for (const key of [...active.keys()]) cancel(key);
  };

  return { start, cancel, cancelAll, isRunning: (key) => active.has(key) };
}

export const verificationRunner = createVerificationRunner();
