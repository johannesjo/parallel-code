import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import { askCodeEnv } from './ask-code.js';
import { RUN_TAG_ENV, signalTagged } from './process-tag.js';
import { validateCommand } from './pty.js';
import { createScreensStream, type ScreensStream } from './task-screens-stream.js';
import { ASK_CODE_MODELS } from '../shared/ask-code-models.js';
import { errMessage, warn as logWarn } from '../log.js';

/** Installing dependencies and starting two apps takes minutes. */
export const SCREENS_TIMEOUT_MS = 10 * 60_000;
const MAX_ANSWER_CHARS = 60_000;
/** Servers that ignore SIGTERM get this long before SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** After the CLI exits, its last output gets this long to arrive through the pipe. */
const DRAIN_GRACE_MS = 1_000;
const TOOLS = 'Bash,Read,Glob,Grep';

/** A running capture: its answer, and ways to end it and everything it started. */
export interface CaptureProcess {
  /** The CLI's answer; the servers it started keep running until `end`. */
  result: Promise<string>;
  /** Fails the run with the reason, and ends it. */
  stop: (reason: string) => void;
  /** Stops the CLI and every process it started; repeat calls do nothing. */
  end: () => void;
  /** The run's environment: a process the app starts with it is stopped by `end` too. */
  env: Record<string, string>;
}

/** SIGKILLs of runs whose processes may still be alive, so a quit can end them. */
const liveRuns = new Map<string, () => void>();

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: every process of the group has exited.
    return;
  }
}

/** Signals the CLI's group and every process carrying the run's tag. */
function signalRun(tag: string, proc: ChildProcess, signal: NodeJS.Signals): void {
  // The group only while the CLI lives: after its exit the pid may be reused.
  if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
    signalGroup(proc.pid, signal);
  }
  // Servers started with setsid or nohup leave the group but keep the tag.
  signalTagged(tag, signal);
}

/** SIGTERM everything the run started, then SIGKILL what survives the grace period. */
function endRun(tag: string, proc: ChildProcess): void {
  signalRun(tag, proc, 'SIGTERM');
  setTimeout(() => {
    signalRun(tag, proc, 'SIGKILL');
    liveRuns.delete(tag);
  }, KILL_GRACE_MS).unref();
}

/** Kills every capture's processes at once; for app quit, which cannot wait. */
export function killAllCaptures(): void {
  for (const kill of liveRuns.values()) kill();
  liveRuns.clear();
}

function spawnClaude(opts: {
  cwd: string;
  addDirs: string[];
  systemPrompt: string;
  env: Record<string, string>;
}): ChildProcessWithoutNullStreams {
  validateCommand('claude');
  const args = [
    ...['-p', '--output-format', 'stream-json', '--verbose', '--model', ASK_CODE_MODELS.claude],
    ...['--tools', TOOLS, '--allowedTools', TOOLS, '--strict-mcp-config'],
    ...opts.addDirs.flatMap((dir) => ['--add-dir', dir]),
    ...['--no-session-persistence', '--append-system-prompt', opts.systemPrompt],
  ];
  // Its own process group, so a stop reaches what it runs in the foreground.
  return spawn('claude', args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: 'pipe',
  });
}

/** How the CLI ended, for errors: its exit code, or the signal that killed it. */
interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** The run's answer once the CLI exited, or why there is none. */
function outcomeOf(stream: ScreensStream, exit: Exit, stderr: string): string {
  const outcome = stream.outcome();
  if (outcome && 'error' in outcome) throw new Error(outcome.error);
  // A delivered answer counts even if the CLI failed while shutting down.
  if (outcome) {
    if (outcome.answer.length > MAX_ANSWER_CHARS) throw new Error('The answer was too long.');
    return outcome.answer;
  }
  if (exit.code === 0) throw new Error('Claude ended without an answer.');
  const how = exit.signal ? `was killed by ${exit.signal}` : `exited with code ${exit.code}`;
  throw new Error(stderr.trim() || `claude ${how}`);
}

/** Collects the run's answer; a stop reason, once marked, wins over how the process ended. */
function collect(proc: ChildProcessWithoutNullStreams, onStep: (step: string) => void) {
  let stopped: string | undefined;
  const stream = createScreensStream(onStep);
  const result = new Promise<string>((resolve, reject) => {
    let err = '';
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (stopped) return reject(new Error(stopped));
      try {
        resolve(outcomeOf(stream, { code, signal }, err));
      } catch (error) {
        reject(error);
      }
    };
    // Decoded as a stream, so a character split across two reads stays whole.
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => stream.feed(chunk));
    proc.stderr.on('data', (chunk: string) => (err = (err + chunk).slice(-2000)));
    proc.on('error', (error) => {
      settled = true;
      reject(error);
    });
    proc.on('close', settle);
    // 'close' waits for every holder of the pipes; a server left running
    // holds them until `end`, so the CLI's exit ends the run.
    proc.on('exit', (code, signal) => {
      setTimeout(() => {
        proc.stdout.destroy();
        proc.stderr.destroy();
        settle(code, signal);
      }, DRAIN_GRACE_MS).unref();
    });
  });
  return { result, markStopped: (reason: string) => (stopped ??= reason) };
}

/**
 * Starts a Claude run with a shell that starts both versions of the app. The
 * servers it leaves running stay up until `end`, so they can be photographed;
 * a run that is stopped, times out or is never ended by the caller before
 * quit is killed with all of them.
 */
export function startCapture(opts: {
  cwd: string;
  addDirs: string[];
  prompt: string;
  systemPrompt: string;
  envFile?: string;
  projectId?: string;
  /** Called with each step the model takes, for progress in the UI. */
  onStep: (step: string) => void;
}): CaptureProcess {
  const tag = randomUUID();
  const env = { ...askCodeEnv(opts.envFile, opts.projectId), [RUN_TAG_ENV]: tag };
  const proc = spawnClaude({ ...opts, env });
  liveRuns.set(tag, () => signalRun(tag, proc, 'SIGKILL'));
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    endRun(tag, proc);
  };
  const run = collect(proc, opts.onStep);
  const stop = (reason: string) => {
    run.markStopped(reason);
    end();
  };
  const timer = setTimeout(() => stop('The capture did not finish in time.'), SCREENS_TIMEOUT_MS);
  const clear = () => clearTimeout(timer);
  run.result.then(clear, clear);
  // A CLI that exits before reading its prompt would otherwise raise EPIPE uncaught.
  proc.stdin.on('error', (error) =>
    logWarn('taskScreens', 'Could not send the prompt', { error: errMessage(error) }),
  );
  proc.stdin.end(opts.prompt);
  return { result: run.result, stop, end, env };
}
