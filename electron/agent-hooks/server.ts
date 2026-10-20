import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import {
  buildClaudeHookSettings,
  buildStatusLineSetting,
  type StatusLineSetting,
} from './claude-settings.js';
import {
  HOOK_AGENT_ID_HEADER,
  HOOK_ENV_AGENT_ID,
  HOOK_ENV_ENDPOINT,
  HOOK_ENV_TASK_ID,
  HOOK_ENV_LAUNCH_ID,
  HOOK_LAUNCH_ID_HEADER,
  HOOK_TASK_ID_HEADER,
  HOOK_TOKEN_HEADER,
  buildEndpointFile,
  buildHookScript,
  buildStatusLineScript,
} from './hook-script.js';
import { isCurrentAgentLaunch } from './observations.js';
import { mapClaudeHookPayload, type AgentHookEventPayload } from './status.js';
import { readUserStatusLine } from './user-status-line.js';
import { warn as logWarn, errMessage } from '../log.js';

/** Hook payloads are small; anything larger is not a hook. */
const MAX_BODY_BYTES = 64 * 1024;

export interface AgentHookServerOptions {
  /** Directory for the endpoint file, hook script, and Claude settings. */
  dir: string;
  onEvent: (event: AgentHookEventPayload) => void;
  /** A Claude Code status line payload, which carries the rate-limit windows. */
  onUsage?: (payload: unknown) => void;
  now?: () => number;
}

export interface AgentHookServer {
  port: number;
  hookScriptPath: string;
  statusLineScriptPath: string;
  /** The `--settings` file for a Claude launch in `cwd` with `env`. */
  claudeSettingsPath(cwd: string, env: Record<string, string | undefined>): string;
  /** Env the PTY layer merges into a Claude launch so the script can find us. */
  buildPtyEnv(agentId: string, taskId: string, launchId: string): Record<string, string>;
  close(): Promise<void>;
}

function headerValue(req: http.IncomingMessage, name: string): string {
  const raw = req.headers[name];
  return (Array.isArray(raw) ? raw[0] : raw) ?? '';
}

function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

function parseJson(body: string | null): unknown {
  if (body === null) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    // A malformed payload is an agent-side bug we cannot fix from here;
    // the hook still gets its 204 so the agent is never blocked on us.
    return null;
  }
}

interface HookFiles {
  hookScriptPath: string;
  statusLineScriptPath: string;
  /** Hooks only: for a launch whose own status line could not be read. */
  hooksOnlySettingsPath: string;
}

function writeFiles(dir: string, port: number, token: string): HookFiles {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const endpointPath = path.join(dir, 'endpoint.env');
  const hookScriptPath = path.join(dir, 'hook.sh');
  const statusLineScriptPath = path.join(dir, 'statusline.sh');
  const hooksOnlySettingsPath = path.join(dir, 'claude-settings.json');
  fs.writeFileSync(endpointPath, buildEndpointFile(port, token), { mode: 0o600 });
  fs.writeFileSync(hookScriptPath, buildHookScript(), { mode: 0o755 });
  fs.writeFileSync(statusLineScriptPath, buildStatusLineScript(), { mode: 0o755 });
  fs.writeFileSync(
    hooksOnlySettingsPath,
    JSON.stringify(buildClaudeHookSettings(hookScriptPath), null, 2) + '\n',
  );
  // `mode` only applies on creation; a directory or token file left over from
  // an older build (or loosened by hand) must be tightened again every launch.
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(endpointPath, 0o600);
  return { hookScriptPath, statusLineScriptPath, hooksOnlySettingsPath };
}

/**
 * Settings files with the usage status line, one per distinct user status line
 * and named by a hash of their contents, so launches share them and a changed
 * status line gets a new file rather than rewriting one a running agent reads.
 */
function statusLineSettings(
  dir: string,
  files: HookFiles,
): (user: StatusLineSetting | null) => string {
  const written = new Set<string>();
  return (user) => {
    const settings = buildClaudeHookSettings(
      files.hookScriptPath,
      buildStatusLineSetting(files.statusLineScriptPath, user),
    );
    const json = JSON.stringify(settings, null, 2) + '\n';
    const hash = createHash('sha256').update(json).digest('hex').slice(0, 16);
    const file = path.join(dir, `claude-settings-${hash}.json`);
    if (!written.has(file)) {
      fs.writeFileSync(file, json);
      written.add(file);
    }
    return file;
  };
}

/**
 * Loopback receiver for agent hook events. Binds a random port on 127.0.0.1
 * and gates requests behind a per-launch bearer token so nothing else on the
 * machine can spoof agent status. Every authenticated request is answered
 * 204, valid or not: the hook script must never be the reason an agent stalls.
 */
export function startAgentHookServer(options: AgentHookServerOptions): Promise<AgentHookServer> {
  const token = randomUUID();
  const now = options.now ?? Date.now;
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || (req.url !== '/hook/claude' && req.url !== '/usage/claude')) {
      res.writeHead(404).end();
      return;
    }
    if (!tokenMatches(token, headerValue(req, HOOK_TOKEN_HEADER))) {
      res.writeHead(403).end();
      return;
    }
    const body = await readBody(req);
    res.writeHead(204).end();
    if (req.url === '/usage/claude') {
      // Rate limits belong to the login, not the launch, so no agent identity is needed.
      const payload = parseJson(body);
      if (payload !== null) options.onUsage?.(payload);
      return;
    }
    const agentId = headerValue(req, HOOK_AGENT_ID_HEADER);
    const update = mapClaudeHookPayload(parseJson(body));
    const taskId = headerValue(req, HOOK_TASK_ID_HEADER);
    const launchId = headerValue(req, HOOK_LAUNCH_ID_HEADER);
    if (!agentId || !update || !isCurrentAgentLaunch(agentId, taskId, launchId)) return;
    options.onEvent({
      ...update,
      agentId,
      taskId,
      launchId,
      at: now(),
    });
  });
  // Hooks are one-shot curls; a lingering keep-alive would only delay shutdown.
  server.keepAliveTimeout = 1000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('agent hook server has no TCP address'));
        return;
      }
      const { port } = address;
      let files: HookFiles;
      try {
        files = writeFiles(options.dir, port, token);
      } catch (err) {
        // Thrown inside a listen callback this would be an uncaught exception,
        // not a rejection — and a hook server nobody can reach is useless anyway.
        server.close();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const endpointPath = path.join(options.dir, 'endpoint.env');
      const withStatusLine = statusLineSettings(options.dir, files);
      resolve({
        port,
        hookScriptPath: files.hookScriptPath,
        statusLineScriptPath: files.statusLineScriptPath,
        claudeSettingsPath: (cwd, env) => {
          const user = readUserStatusLine(cwd, env);
          // Unreadable settings: register no status line rather than replace one we cannot see.
          if (user === undefined) return files.hooksOnlySettingsPath;
          try {
            return withStatusLine(user);
          } catch (err) {
            logWarn('agent-hooks', 'failed to write status line settings', {
              err: errMessage(err),
            });
            return files.hooksOnlySettingsPath;
          }
        },
        buildPtyEnv: (agentId, taskId, launchId) => ({
          [HOOK_ENV_ENDPOINT]: endpointPath,
          [HOOK_ENV_AGENT_ID]: agentId,
          [HOOK_ENV_TASK_ID]: taskId,
          [HOOK_ENV_LAUNCH_ID]: launchId,
        }),
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
