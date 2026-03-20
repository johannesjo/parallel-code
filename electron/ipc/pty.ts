import * as pty from 'node-pty';
import { execFileSync, execFile, spawn as cpSpawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { BrowserWindow } from 'electron';
import { RingBuffer } from '../remote/ring-buffer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PtySession {
  proc: pty.IPty;
  channelId: string;
  taskId: string;
  agentId: string;
  isShell: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
  subscribers: Set<(encoded: string) => void>;
  scrollback: RingBuffer;
  /** Assigned container name when running in Docker mode, null otherwise. */
  containerName: string | null;
}

const sessions = new Map<string, PtySession>();

// --- PTY event bus for spawn/exit notifications ---

type PtyEventType = 'spawn' | 'exit' | 'list-changed';
type PtyEventListener = (agentId: string, data?: unknown) => void;
const eventListeners = new Map<PtyEventType, Set<PtyEventListener>>();

/** Register a listener for PTY lifecycle events. Returns an unsubscribe function. */
export function onPtyEvent(event: PtyEventType, listener: PtyEventListener): () => void {
  let listeners = eventListeners.get(event);
  if (!listeners) {
    listeners = new Set();
    eventListeners.set(event, listeners);
  }
  listeners.add(listener);
  return () => {
    eventListeners.get(event)?.delete(listener);
  };
}

function emitPtyEvent(event: PtyEventType, agentId: string, data?: unknown): void {
  eventListeners.get(event)?.forEach((fn) => fn(agentId, data));
}

/** Notify listeners that the agent list has changed (e.g. task deleted). */
export function notifyAgentListChanged(): void {
  emitPtyEvent('list-changed', '');
}

const BATCH_MAX = 64 * 1024;
const BATCH_INTERVAL = 8; // ms
const TAIL_CAP = 8 * 1024;
const MAX_LINES = 50;

/** Verify that a command exists in PATH. Throws a descriptive error if not found. */
export function validateCommand(command: string): void {
  if (!command || !command.trim()) {
    throw new Error('Command must not be empty.');
  }
  // Absolute paths: check directly via filesystem
  if (command.startsWith('/')) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return;
    } catch {
      throw new Error(
        `Command '${command}' not found or not executable. Check that it is installed.`,
      );
    }
  }
  // Bare names: resolve via `which` (execFileSync — no shell interpolation)
  try {
    execFileSync('which', [command], { encoding: 'utf8', timeout: 3000 });
  } catch {
    throw new Error(
      `Command '${command}' not found in PATH. Make sure it is installed and available in your terminal.`,
    );
  }
}

export function spawnAgent(
  win: BrowserWindow,
  args: {
    taskId: string;
    agentId: string;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
    isShell?: boolean;
    dockerMode?: boolean;
    dockerImage?: string;
    onOutput: { __CHANNEL_ID__: string };
  },
): void {
  const channelId = args.onOutput.__CHANNEL_ID__;
  const command = args.command || process.env.SHELL || '/bin/sh';
  const cwd = args.cwd || process.env.HOME || '/';

  // Reject commands with shell metacharacters (node-pty uses execvp, but
  // guard against accidental misuse). Allow bare names (resolved via PATH)
  // and absolute paths.
  if (/[;&|`$(){}\n]/.test(command)) {
    throw new Error(`Command contains disallowed characters: ${command}`);
  }

  // In Docker mode, we validate `docker` exists rather than the inner command
  if (!args.dockerMode) {
    validateCommand(command);
  } else {
    validateCommand('docker');
  }

  // Kill any existing session with the same agentId to prevent PTY leaks
  const existing = sessions.get(args.agentId);
  if (existing) {
    if (existing.flushTimer) clearTimeout(existing.flushTimer);
    existing.subscribers.clear();
    existing.proc.kill();
    sessions.delete(args.agentId);
  }

  const filteredEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) filteredEnv[k] = v;
  }

  // Only allow safe env overrides from renderer. Reject vars that could
  // alter process loading or execution behavior.
  const ENV_BLOCK_LIST = new Set([
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
  ]);
  const safeEnvOverrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.env ?? {})) {
    if (!ENV_BLOCK_LIST.has(k)) safeEnvOverrides[k] = v;
  }

  const spawnEnv: Record<string, string> = {
    ...filteredEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...safeEnvOverrides,
  };

  // Clear env vars that prevent nested agent sessions
  delete spawnEnv.CLAUDECODE;
  delete spawnEnv.CLAUDE_CODE_SESSION;
  delete spawnEnv.CLAUDE_CODE_ENTRYPOINT;

  let spawnCommand: string;
  let spawnArgs: string[];

  // Derive a predictable, unique container name from the agentId so we can
  // reliably stop it later without having to parse docker inspect output.
  const containerName = args.dockerMode
    ? `parallel-code-${args.agentId.slice(0, 12)}`
    : null;

  if (args.dockerMode) {
    const name = containerName as string;
    const image = args.dockerImage || DOCKER_DEFAULT_IMAGE;
    spawnCommand = 'docker';
    spawnArgs = [
      'run',
      '--rm',
      '-it',
      // Predictable name so we can stop the container on kill
      '--name',
      name,
      // Label so we can identify all containers owned by this app
      '--label',
      'parallel-code=true',
      // Host networking — agents need internet access for API calls and package installs.
      // Filesystem isolation (volume mounts) is the primary safety goal, not network isolation.
      '--network',
      'host',
      // Resource limits to prevent runaway containers
      '--memory',
      '8g',
      '--pids-limit',
      '512',
      // Run as host user so container files are owned by the host user
      '--user',
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      // Mount the project directory as the only writable volume
      '-v',
      `${cwd}:${cwd}`,
      '-w',
      cwd,
      // Forward env vars the agent needs (API keys, git config, etc.)
      ...buildDockerEnvFlags(spawnEnv),
      // Mount SSH and git config read-only for git operations
      ...buildDockerCredentialMounts(),
      image,
      command,
      ...args.args,
    ];
  } else {
    spawnCommand = command;
    spawnArgs = args.args;
  }

  const proc = pty.spawn(spawnCommand, spawnArgs, {
    name: 'xterm-256color',
    cols: args.cols,
    rows: args.rows,
    cwd: args.dockerMode ? undefined : cwd,
    env: args.dockerMode ? filteredEnv : spawnEnv,
  });

  const session: PtySession = {
    proc,
    channelId,
    taskId: args.taskId,
    agentId: args.agentId,
    isShell: args.isShell ?? false,
    flushTimer: null,
    subscribers: new Set(),
    scrollback: new RingBuffer(),
    containerName,
  };
  sessions.set(args.agentId, session);

  // Batching strategy matching the Rust implementation
  let batch = Buffer.alloc(0);
  let tailBuf = Buffer.alloc(0);

  const send = (msg: unknown) => {
    if (!win.isDestroyed()) {
      win.webContents.send(`channel:${channelId}`, msg);
    }
  };

  const flush = () => {
    if (batch.length === 0) return;
    const encoded = batch.toString('base64');
    send({ type: 'Data', data: encoded });
    session.scrollback.write(batch);
    for (const sub of session.subscribers) {
      sub(encoded);
    }
    batch = Buffer.alloc(0);
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
  };

  proc.onData((data: string) => {
    const chunk = Buffer.from(data, 'utf8');

    // Maintain tail buffer for exit diagnostics
    tailBuf = Buffer.concat([tailBuf, chunk]);
    if (tailBuf.length > TAIL_CAP) {
      tailBuf = tailBuf.subarray(tailBuf.length - TAIL_CAP);
    }

    batch = Buffer.concat([batch, chunk]);

    // Flush large batches immediately
    if (batch.length >= BATCH_MAX) {
      flush();
      return;
    }

    // Small read = likely interactive prompt, flush immediately
    if (chunk.length < 1024) {
      flush();
      return;
    }

    // Otherwise schedule flush on timer
    if (!session.flushTimer) {
      session.flushTimer = setTimeout(flush, BATCH_INTERVAL);
    }
  });

  proc.onExit(({ exitCode, signal }) => {
    // If this session was replaced by a new spawn with the same agentId,
    // skip cleanup — the new session owns the map entry now.
    if (sessions.get(args.agentId) !== session) return;

    // Flush any remaining buffered data
    flush();

    // Parse tail buffer into last N lines for exit diagnostics
    const tailStr = tailBuf.toString('utf8');
    const lines = tailStr
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.length > 0)
      .slice(-MAX_LINES);

    send({
      type: 'Exit',
      data: {
        exit_code: exitCode,
        signal: signal !== undefined ? String(signal) : null,
        last_output: lines,
      },
    });

    emitPtyEvent('exit', args.agentId, { exitCode, signal });
    sessions.delete(args.agentId);
  });

  emitPtyEvent('spawn', args.agentId);
}

export function writeToAgent(agentId: string, data: string): void {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  session.proc.write(data);
}

export function resizeAgent(agentId: string, cols: number, rows: number): void {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  session.proc.resize(cols, rows);
}

export function pauseAgent(agentId: string): void {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  session.proc.pause();
}

export function resumeAgent(agentId: string): void {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  session.proc.resume();
}

export function killAgent(agentId: string): void {
  const session = sessions.get(agentId);
  if (session) {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    // Clear subscribers before kill so the onExit flush doesn't
    // notify stale listeners. Let onExit handle sessions.delete
    // and emitPtyEvent to avoid the race condition.
    session.subscribers.clear();
    // Stop the Docker container first so it doesn't keep running after the
    // local PTY process (docker run) is killed. Fire-and-forget; the PTY kill
    // below is the authoritative termination signal.
    if (session.containerName) {
      stopDockerContainer(session.containerName);
    }
    session.proc.kill();
  }
}

export function countRunningAgents(): number {
  return sessions.size;
}

export function killAllAgents(): void {
  for (const [, session] of sessions) {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.subscribers.clear();
    if (session.containerName) {
      // Use synchronous docker kill with a short timeout so containers are
      // terminated before the Electron process exits. Errors are ignored
      // (container may already be gone).
      try {
        execFileSync('docker', ['kill', session.containerName], { timeout: 3000, stdio: 'pipe' });
      } catch {
        // Intentionally ignore: container may not exist or may have already stopped.
      }
    }
    session.proc.kill();
  }
  // Let onExit handlers clean up sessions individually
}

// --- Subscriber helpers for remote access ---

/** Subscribe to live base64-encoded output from an agent. */
export function subscribeToAgent(agentId: string, cb: (encoded: string) => void): boolean {
  const session = sessions.get(agentId);
  if (!session) return false;
  session.subscribers.add(cb);
  return true;
}

/** Remove a previously registered output subscriber. */
export function unsubscribeFromAgent(agentId: string, cb: (encoded: string) => void): void {
  sessions.get(agentId)?.subscribers.delete(cb);
}

/** Get the scrollback buffer for an agent as a base64 string. */
export function getAgentScrollback(agentId: string): string | null {
  return sessions.get(agentId)?.scrollback.toBase64() ?? null;
}

/** Return all active agent IDs. */
export function getActiveAgentIds(): string[] {
  return Array.from(sessions.keys());
}

/** Return metadata for a specific agent, or null if not found. */
export function getAgentMeta(
  agentId: string,
): { taskId: string; agentId: string; isShell: boolean } | null {
  const s = sessions.get(agentId);
  return s ? { taskId: s.taskId, agentId: s.agentId, isShell: s.isShell } : null;
}

/** Return the current column width of an agent's PTY. */
export function getAgentCols(agentId: string): number {
  const s = sessions.get(agentId);
  return s ? s.proc.cols : 80;
}

// --- Docker mode helpers ---

/**
 * Env vars that are desktop/host-specific and must NOT be forwarded into the
 * container. Everything else is forwarded so agents can use arbitrary vars
 * (custom API keys, feature flags, tool config, etc.) without needing an
 * ever-growing allowlist.
 */
const DOCKER_ENV_BLOCK_LIST = new Set([
  // Display / desktop session
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'DBUS_SYSTEM_BUS_ADDRESS',
  'DESKTOP_SESSION',
  'XDG_CURRENT_DESKTOP',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_CLASS',
  'XDG_SESSION_ID',
  'XDG_SESSION_TYPE',
  'XDG_VTNR',
  'WINDOWID',
  'XAUTHORITY',
  // Electron / Node host internals
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING',
  // Host-specific paths / linker
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  // Session / PAM
  'LOGNAME',
  'MAIL',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_DIRS',
  // Active Claude Code session markers (prevent nested session confusion)
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  // SSH / GPG / k8s — agent sockets and credentials must not leak into container
  'SSH_AUTH_SOCK',
  'GPG_AGENT_INFO',
  'KUBECONFIG',
]);

/** Returns true for env var names that should be blocked from Docker forwarding. */
function isBlockedDockerEnvKey(key: string): boolean {
  if (DOCKER_ENV_BLOCK_LIST.has(key)) return true;
  // Block all remaining XDG_* vars not explicitly listed above
  if (key.startsWith('XDG_')) return true;
  // Block all ELECTRON_* vars not explicitly listed above
  if (key.startsWith('ELECTRON_')) return true;
  // Block all SUDO_* vars (e.g. SUDO_USER, SUDO_UID) — host privilege context
  if (key.startsWith('SUDO_')) return true;
  return false;
}

function buildDockerEnvFlags(env: Record<string, string>): string[] {
  const flags: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!isBlockedDockerEnvKey(key) && value !== undefined) {
      flags.push('-e', `${key}=${value}`);
    }
  }
  return flags;
}

function buildDockerCredentialMounts(): string[] {
  const mounts: string[] = [];
  const home = process.env.HOME;
  if (!home) return mounts;

  /** Mount a path read-only if it is readable; silently skip if absent. */
  const mountIfExists = (hostPath: string): void => {
    try {
      fs.accessSync(hostPath, fs.constants.R_OK);
      mounts.push('-v', `${hostPath}:${hostPath}:ro`);
    } catch {
      // Path absent or unreadable — skip
    }
  };

  // SSH keys for git push/pull
  mountIfExists(`${home}/.ssh`);

  // Git identity / config
  mountIfExists(`${home}/.gitconfig`);

  // GitHub CLI auth tokens (~/.config/gh/)
  mountIfExists(`${home}/.config/gh`);

  // npm auth token
  mountIfExists(`${home}/.npmrc`);

  // General HTTP/git HTTPS credentials (used by git credential helper)
  mountIfExists(`${home}/.netrc`);

  // Google Application Credentials file (for Vertex AI / gcloud)
  const googleCredsFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (googleCredsFile) {
    mountIfExists(googleCredsFile);
  }

  return mounts;
}

/**
 * Asynchronously stop a Docker container by name. Fire-and-forget — errors are
 * silently swallowed because the container may have already exited by the time
 * this is called.
 */
function stopDockerContainer(name: string): void {
  execFile('docker', ['stop', name], { timeout: 10_000 }, () => {
    // Intentionally ignore errors: container may not exist or may have already stopped.
  });
}

/** Check if Docker is available on the system. */
export async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('docker', ['info'], { encoding: 'utf8', timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

/** The default image name for Docker-isolated tasks. */
export const DOCKER_DEFAULT_IMAGE = 'parallel-code-agent:latest';

/** Check if a Docker image exists locally. */
export async function dockerImageExists(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('docker', ['image', 'inspect', image], { encoding: 'utf8', timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

/** Deduplicates concurrent calls to buildDockerImage. Null when no build is in progress. */
let activeBuild: Promise<{ ok: boolean; error?: string }> | null = null;

/**
 * Build the bundled Dockerfile into parallel-code-agent:latest.
 * Streams build output to the renderer via an IPC channel so the user can see progress.
 * Returns a promise that resolves on success, rejects on failure.
 * Concurrent calls return the same in-flight promise.
 */
export function buildDockerImage(
  win: BrowserWindow,
  onOutputChannel: string,
): Promise<{ ok: boolean; error?: string }> {
  if (activeBuild !== null) {
    return activeBuild;
  }

  activeBuild = new Promise((resolve) => {
    const finish = (result: { ok: boolean; error?: string }) => {
      activeBuild = null;
      resolve(result);
    };
    // Locate the Dockerfile bundled with the app.
    // In dev mode it's at <repo>/docker/Dockerfile
    // In production it's in the app.asar resources directory
    const devDockerDir = path.join(__dirname, '..', '..', 'docker');
    const prodDockerDir = path.join(process.resourcesPath ?? '', 'docker');
    const dockerDir = fs.existsSync(path.join(devDockerDir, 'Dockerfile'))
      ? devDockerDir
      : prodDockerDir;
    const dockerfilePath = path.join(dockerDir, 'Dockerfile');

    if (!fs.existsSync(dockerfilePath)) {
      finish({ ok: false, error: `Dockerfile not found at ${dockerfilePath}` });
      return;
    }

    const send = (text: string) => {
      if (!win.isDestroyed()) {
        win.webContents.send(onOutputChannel, text);
      }
    };

    const proc = cpSpawn('docker', ['build', '-t', DOCKER_DEFAULT_IMAGE, '-f', dockerfilePath, dockerDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (chunk: Buffer) => send(chunk.toString('utf8')));
    proc.stderr?.on('data', (chunk: Buffer) => send(chunk.toString('utf8')));

    proc.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true });
      } else {
        finish({ ok: false, error: `docker build exited with code ${code}` });
      }
    });
  });

  return activeBuild;
}
