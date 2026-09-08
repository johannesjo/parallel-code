import { randomUUID, timingSafeEqual } from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { buildClaudeHookSettings } from './claude-settings.js';
import {
  HOOK_AGENT_ID_HEADER,
  HOOK_ENV_AGENT_ID,
  HOOK_ENV_ENDPOINT,
  HOOK_ENV_TASK_ID,
  HOOK_TASK_ID_HEADER,
  HOOK_TOKEN_HEADER,
  buildEndpointFile,
  buildHookScript,
} from './hook-script.js';
import { mapClaudeHookPayload, type AgentHookEventPayload } from './status.js';

/** Hook payloads are small; anything larger is not a hook. */
const MAX_BODY_BYTES = 64 * 1024;

export interface AgentHookServerOptions {
  /** Directory for the endpoint file, hook script, and Claude settings. */
  dir: string;
  onEvent: (event: AgentHookEventPayload) => void;
  now?: () => number;
}

export interface AgentHookServer {
  port: number;
  hookScriptPath: string;
  claudeSettingsPath: string;
  /** Env the PTY layer merges into a Claude launch so the script can find us. */
  buildPtyEnv(agentId: string, taskId: string): Record<string, string>;
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

function writeFiles(
  dir: string,
  port: number,
  token: string,
): Pick<AgentHookServer, 'hookScriptPath' | 'claudeSettingsPath'> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const endpointPath = path.join(dir, 'endpoint.env');
  const hookScriptPath = path.join(dir, 'hook.sh');
  const claudeSettingsPath = path.join(dir, 'claude-settings.json');
  fs.writeFileSync(endpointPath, buildEndpointFile(port, token), { mode: 0o600 });
  fs.writeFileSync(hookScriptPath, buildHookScript(), { mode: 0o755 });
  fs.writeFileSync(
    claudeSettingsPath,
    JSON.stringify(buildClaudeHookSettings(hookScriptPath), null, 2) + '\n',
  );
  // `mode` only applies on creation; a directory or token file left over from
  // an older build (or loosened by hand) must be tightened again every launch.
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(endpointPath, 0o600);
  return { hookScriptPath, claudeSettingsPath };
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
    if (req.method !== 'POST' || req.url !== '/hook/claude') {
      res.writeHead(404).end();
      return;
    }
    if (!tokenMatches(token, headerValue(req, HOOK_TOKEN_HEADER))) {
      res.writeHead(403).end();
      return;
    }
    const body = await readBody(req);
    res.writeHead(204).end();
    const agentId = headerValue(req, HOOK_AGENT_ID_HEADER);
    const update = mapClaudeHookPayload(parseJson(body));
    if (!agentId || !update) return;
    options.onEvent({
      ...update,
      agentId,
      taskId: headerValue(req, HOOK_TASK_ID_HEADER),
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
      let files: ReturnType<typeof writeFiles>;
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
      resolve({
        port,
        ...files,
        buildPtyEnv: (agentId, taskId) => ({
          [HOOK_ENV_ENDPOINT]: endpointPath,
          [HOOK_ENV_AGENT_ID]: agentId,
          [HOOK_ENV_TASK_ID]: taskId,
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
