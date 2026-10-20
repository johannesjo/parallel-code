import { spawn } from 'node:child_process';

/** Output kept per stream. The CLI cuts its own `!` output near this size, which
 *  is also what goes into the conversation for the model to read. */
const OUTPUT_LIMIT = 30_000;
const TRUNCATED = '\n… output truncated';
/** How long output may trail the shell's exit before the command counts as done. */
const DRAIN_MS = 300;
/** How long Stop waits before it stops asking. */
const KILL_AFTER_MS = 2_000;

export interface ShellRun {
  /** Resolves with the exit code, or undefined when a signal ended the command. */
  done: Promise<number | undefined>;
  /** Resolves once nothing the command started holds its output any more. */
  closed: Promise<void>;
  /** Both streams interleaved, as a terminal shows them. */
  output(): string;
  /** The command and its output in the CLI's own transcript format. */
  transcript(exitCode: number | undefined): string;
  /** Stops the command, or once it has exited, the jobs it left running. */
  kill(): void;
  readonly killed: boolean;
}

/**
 * Run a command the user typed after `!`, through their shell, in the worktree.
 * No stdin: a command that waits for input gets end-of-file rather than hanging.
 */
export function runShellCommand(opts: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  onOutput: () => void;
}): ShellRun {
  const buffers = { stdout: '', stderr: '', combined: '' };
  let truncated = false;
  let killed = false;
  let exited = false;
  let finished = false;
  let closed = false;
  // Its own process group, so Stop also ends whatever the command started.
  const child = spawn(opts.env.SHELL || '/bin/sh', ['-c', opts.command], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  for (const stream of ['stdout', 'stderr'] as const) {
    child[stream].setEncoding('utf8');
    child[stream].on('data', (chunk: string) => {
      if (finished) return;
      for (const key of [stream, 'combined'] as const) {
        const room = OUTPUT_LIMIT - buffers[key].length;
        if (chunk.length > room) truncated = true;
        if (room > 0) buffers[key] += chunk.slice(0, room);
      }
      opts.onOutput();
    });
  }
  const done = new Promise<number | undefined>((resolve, reject) => {
    child.once('error', reject);
    // 'close' waits for every holder of the output pipes, and a job the command
    // left in the background may hold them for good; the shell's exit is the end.
    child.once('exit', (code) => {
      exited = true;
      const settle = () => {
        finished = true;
        clearTimeout(drain);
        resolve(code ?? undefined);
      };
      const drain = setTimeout(settle, DRAIN_MS);
      child.once('close', settle);
    });
  });
  const whenClosed = new Promise<void>((resolve) =>
    child.once('close', () => {
      closed = true;
      resolve();
    }),
  );
  const signal = (name: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, name);
    } catch (error) {
      // The group is already gone when the command finished first.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const note = () => (truncated ? TRUNCATED : '');
  return {
    done,
    closed: whenClosed,
    output: () => buffers.combined + note(),
    transcript: (exitCode) => {
      // The model reads only this, so a failure has to say so in it.
      const status = killed
        ? 'Stopped by the user.'
        : exitCode === 0
          ? ''
          : `Exit code ${exitCode ?? 'unknown'}`;
      const stderr = [buffers.stderr, status].filter(Boolean).join('\n');
      return `<bash-input>${opts.command}</bash-input>\n<bash-stdout>${buffers.stdout + note()}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`;
    },
    kill: () => {
      // Closed output means the group is empty, and its id may since belong to another.
      if (closed) return;
      if (!exited) killed = true;
      signal('SIGTERM');
      // A command may ignore SIGTERM; Stop has to end it all the same.
      setTimeout(() => !closed && signal('SIGKILL'), KILL_AFTER_MS).unref();
    },
    get killed() {
      return killed;
    },
  };
}
