import * as pty from "node-pty";
import type { BrowserWindow } from "electron";

interface PtySession {
  proc: pty.IPty;
  channelId: string;
  taskId: string;
  agentId: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, PtySession>();

const BATCH_MAX = 64 * 1024;
const BATCH_INTERVAL = 8; // ms
const TAIL_CAP = 8 * 1024;
const MAX_LINES = 50;

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
    onOutput: { __CHANNEL_ID__: string };
  }
): void {
  const channelId = args.onOutput.__CHANNEL_ID__;
  const command = args.command || process.env.SHELL || "/bin/sh";
  const cwd = args.cwd || process.env.HOME || "/";

  // Reject commands with shell metacharacters (node-pty uses execvp, but
  // guard against accidental misuse). Allow bare names (resolved via PATH)
  // and absolute paths.
  if (/[;&|`$(){}\n]/.test(command)) {
    throw new Error(`Command contains disallowed characters: ${command}`);
  }

  const filteredEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) filteredEnv[k] = v;
  }

  // Only allow safe env overrides from renderer. Reject vars that could
  // alter process loading or execution behavior.
  const ENV_BLOCK_LIST = new Set([
    "PATH", "HOME", "USER", "SHELL",
    "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
    "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE",
  ]);
  const safeEnvOverrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.env ?? {})) {
    if (!ENV_BLOCK_LIST.has(k)) safeEnvOverrides[k] = v;
  }

  const spawnEnv: Record<string, string> = {
    ...filteredEnv,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    ...safeEnvOverrides,
  };

  // Clear env vars that prevent nested agent sessions
  delete spawnEnv.CLAUDECODE;
  delete spawnEnv.CLAUDE_CODE_SESSION;
  delete spawnEnv.CLAUDE_CODE_ENTRYPOINT;

  const proc = pty.spawn(command, args.args, {
    name: "xterm-256color",
    cols: args.cols,
    rows: args.rows,
    cwd,
    env: spawnEnv,
  });

  const session: PtySession = {
    proc,
    channelId,
    taskId: args.taskId,
    agentId: args.agentId,
    flushTimer: null,
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
    const encoded = batch.toString("base64");
    send({ type: "Data", data: encoded });
    batch = Buffer.alloc(0);
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
  };

  proc.onData((data: string) => {
    const chunk = Buffer.from(data, "utf8");

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
    // Flush any remaining buffered data
    flush();

    // Parse tail buffer into last N lines for exit diagnostics
    const tailStr = tailBuf.toString("utf8");
    const lines = tailStr
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.length > 0)
      .slice(-MAX_LINES);

    send({
      type: "Exit",
      data: {
        exit_code: exitCode,
        signal: signal !== undefined ? String(signal) : null,
        last_output: lines,
      },
    });

    sessions.delete(args.agentId);
  });
}

export function writeToAgent(agentId: string, data: string): void {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  session.proc.write(data);
}

export function resizeAgent(
  agentId: string,
  cols: number,
  rows: number
): void {
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
    session.proc.kill();
    sessions.delete(agentId);
  }
}

export function countRunningAgents(): number {
  return sessions.size;
}

export function killAllAgents(): void {
  for (const [, session] of sessions) {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.proc.kill();
  }
  sessions.clear();
}
