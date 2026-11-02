import { spawn } from 'child_process';
import { closeSync, openSync } from 'fs';
import { readFile } from 'fs/promises';
import { request } from 'http';
import { createServer, type Server } from 'net';

/** A dev server compiles on its first start; past this it counts as not starting. */
const SERVE_TIMEOUT_MS = 90_000;
const POLL_MS = 250;
const LOG_TAIL_CHARS = 400;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function listenAnywhere(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Ports nothing listens on now, one for each version of the app to serve on. */
export async function freePorts(count: number): Promise<number[]> {
  // All held open at once, so the system cannot hand out the same port twice.
  const servers = await Promise.all(Array.from({ length: count }, listenAnywhere));
  const ports = servers.map((server) => {
    const address = server.address();
    return typeof address === 'object' && address ? address.port : 0;
  });
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  if (ports.includes(0)) throw new Error('No free port.');
  return ports;
}

/** True once the port answers HTTP; an error status still means the server is up. */
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: 'localhost', port, path: '/', timeout: 2_000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function logTail(file: string): Promise<string> {
  // shortcut: reads the whole log — a dev server's start-up output is small.
  const text = (await readFile(file, 'utf8').catch(() => '')).trim();
  return text ? ` Its output ends: ${text.slice(-LOG_TAIL_CHARS)}` : '';
}

export interface ServeOptions {
  /** The checkout the command runs in. */
  cwd: string;
  /** A shell command that serves the app in the foreground on `$PORT`. */
  command: string;
  port: number;
  /** Carries the capture's run tag, so ending the capture stops the server. */
  env: Record<string, string>;
  logFile: string;
  /** True once the capture is cancelled: a launcher that exited 0 is otherwise waited on. */
  cancelled: () => boolean;
}

/** Spawns the command; returns how it ended, once it has, for errors. */
function spawnServer(opts: ServeOptions): () => string | undefined {
  let ended: string | undefined;
  const log = openSync(opts.logFile, 'a');
  try {
    // Its own process group, away from the app's; the run tag finds it to stop it.
    const child = spawn('/bin/sh', ['-c', opts.command], {
      cwd: opts.cwd,
      env: { ...opts.env, PORT: String(opts.port) },
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.on('error', (error) => (ended = error.message));
    // Exit 0 may be a launcher that put the server in the background: keep waiting.
    child.on('exit', (code, signal) => {
      if (code !== 0) ended = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
    });
    child.unref();
  } finally {
    closeSync(log);
  }
  return () => ended;
}

/**
 * Starts a version of the app outside Claude's sandbox, where the screenshot
 * window can reach it, and resolves once it answers on its port.
 */
export async function startServer(opts: ServeOptions, timeoutMs = SERVE_TIMEOUT_MS): Promise<void> {
  const endedHow = spawnServer(opts);
  const deadline = Date.now() + timeoutMs;
  while (!(await answers(opts.port))) {
    if (opts.cancelled()) throw new Error('cancelled');
    const ended = endedHow();
    if (ended) throw new Error(`The server ${ended}.${await logTail(opts.logFile)}`);
    if (Date.now() > deadline) {
      const seconds = Math.round(timeoutMs / 1000);
      throw new Error(
        `The server did not answer on port ${opts.port} within ${seconds}s.${await logTail(opts.logFile)}`,
      );
    }
    await delay(POLL_MS);
  }
}
