import { execFile, spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import os from 'os';
import readline from 'readline';
import { promisify } from 'util';
import { errMessage, warn as logWarn } from '../log.js';
import {
  buildCodexHookOverrides,
  buildCodexTrustOverride,
  codexConfigArgs,
  type CodexHookTrust,
} from './codex-hooks.js';

const PROBE_TIMEOUT_MS = 5_000;
const RETRY_FAILED_MS = 60_000;
/** How Codex names the configuration layer its `-c` flags form. */
const SESSION_FLAGS = 'session-flags';

interface ListedHook extends CodexHookTrust {
  trusted: boolean;
}

interface HookListing {
  hooks: ListedHook[];
  /** Codex warned or failed on something the flags themselves say. */
  complained: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** The hooks Codex read from its command-line flags, out of a `hooks/list` result. */
function parseListing(result: unknown): HookListing {
  const data = asRecord(result).data;
  const entry = asRecord(Array.isArray(data) ? data[0] : undefined);
  const listed: unknown[] = Array.isArray(entry.hooks) ? entry.hooks : [];
  const hooks = listed.map(asRecord).flatMap((hook) => {
    const { key, currentHash: hash } = hook;
    if (hook.source !== 'sessionFlags' || typeof key !== 'string' || typeof hash !== 'string')
      return [];
    return [{ key, hash, trusted: hook.trustStatus === 'trusted' && hook.enabled === true }];
  });
  const complaints = JSON.stringify([entry.warnings ?? [], entry.errors ?? []]);
  return { hooks, complained: complaints.includes(SESSION_FLAGS) };
}

interface Probe {
  command: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

type AppServer = ChildProcessByStdio<Writable, Readable, null>;

/** The app server's handshake and then the one request, resolving with its result. */
function requestHookList(child: AppServer, cwd: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    child.on('error', reject);
    child.on('exit', () => reject(new Error('Codex exited before answering')));
    // A Codex that exits early closes the pipe, and an unheard write error would throw.
    child.stdin.on('error', reject);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const message = parseJsonLine(line);
      if (message.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
      }
      if (message.id !== 2) return;
      if (message.error)
        reject(new Error(`Codex cannot list hooks: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    });
    const clientInfo = { name: 'parallel-code', version: '1' };
    send({ id: 1, method: 'initialize', params: { clientInfo } });
  });
}

/**
 * Asks Codex itself which hooks a set of overrides registers. Its app server
 * answers over stdio without a model or a network, and it is the only source of
 * the hash a trust entry must carry.
 */
async function listCodexHooks(probe: Probe, overrides: readonly string[]): Promise<HookListing> {
  const cwd = os.tmpdir();
  const args = [...codexConfigArgs(overrides), 'app-server'];
  const stdio: ['pipe', 'pipe', 'ignore'] = ['pipe', 'pipe', 'ignore'];
  const child = spawn(probe.command, args, { cwd, env: probe.env, stdio });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Codex did not answer in time')), probe.timeoutMs);
  });
  try {
    return parseListing(await Promise.race([requestHookList(child, cwd), timeout]));
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

function parseJsonLine(line: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    // Not a protocol message, e.g. a log line; the reply is still to come.
    return {};
  }
}

/** The hook flags plus their trust entries, once Codex confirms it trusts them. */
async function probeCodexHookArgs(probe: Probe, hookScriptPath: string): Promise<string[]> {
  const overrides = buildCodexHookOverrides(hookScriptPath);
  const listed = await listCodexHooks(probe, overrides);
  if (listed.hooks.length !== overrides.length)
    throw new Error(`Codex listed ${listed.hooks.length} of ${overrides.length} hooks`);
  const trusted = [...overrides, buildCodexTrustOverride(listed.hooks)];
  // Checked rather than assumed: an entry Codex does not accept would put its
  // review dialog in front of the user on every launch.
  const check = await listCodexHooks(probe, trusted);
  const accepted =
    check.hooks.length === overrides.length && check.hooks.every((hook) => hook.trusted);
  if (!accepted || check.complained) throw new Error('Codex did not accept the hooks as trusted');
  return codexConfigArgs(trusted);
}

type Run = () => Promise<string[]>;

/**
 * One run per key, shared by launches that arrive together. A failed run is
 * repeated after a pause rather than kept for good (it may only have been a
 * busy machine at startup) or tried per launch (each try holds a launch up).
 */
function createProbeCache(now: () => number): (key: string, run: Run) => Promise<string[]> {
  const probes = new Map<string, { args: Promise<string[]>; failedAt?: number }>();
  return (key, run) => {
    const last = probes.get(key);
    if (last && (last.failedAt === undefined || now() - last.failedAt < RETRY_FAILED_MS))
      return last.args;
    const probe: { args: Promise<string[]>; failedAt?: number } = { args: run() };
    probes.set(key, probe);
    probe.args.catch(() => {
      probe.failedAt = now();
    });
    return probe.args;
  };
}

export type CodexHookArgs = (command: string, env: NodeJS.ProcessEnv) => Promise<string[]>;

/**
 * Returns the flags that make a Codex launch report its status to the app, or
 * none when this Codex cannot take them (too old, or anything else going
 * wrong): the launch then runs as before, on terminal heuristics.
 */
export function createCodexHookArgs(options: {
  hookScriptPath: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  now?: () => number;
}): CodexHookArgs {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  // shortcut: none on Windows, where Codex running the POSIX hook script is
  // unverified — check `/bin/sh` there (as the Claude hooks rely on) to enable it.
  if ((options.platform ?? process.platform) === 'win32') return () => Promise.resolve([]);
  const probeOnce = createProbeCache(options.now ?? Date.now);
  return async (command, env) => {
    try {
      const run = promisify(execFile);
      const { stdout } = await run(command, ['--version'], { env, timeout: timeoutMs });
      // Keyed by version: a hash from another Codex release may no longer match.
      return await probeOnce(`${command}\n${stdout}`, () =>
        probeCodexHookArgs({ command, env, timeoutMs }, options.hookScriptPath),
      );
    } catch (err) {
      logWarn('agent-hooks', 'Codex hooks unavailable; using PTY heuristics', {
        err: errMessage(err),
      });
      return [];
    }
  };
}
