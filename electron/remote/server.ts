// electron/remote/server.ts

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { existsSync, createReadStream } from 'fs';
import { join, resolve, relative, extname, isAbsolute } from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, timingSafeEqual } from 'crypto';
import { networkInterfaces } from 'os';
import {
  writeToAgent,
  resizeAgent,
  killAgent,
  subscribeToAgent,
  unsubscribeFromAgent,
  getAgentScrollback,
  getActiveAgentIds,
  getAgentMeta,
  getAgentCols,
  onPtyEvent,
} from '../ipc/pty.js';
import { parseClientMessage, type ServerMessage, type RemoteAgent } from './protocol.js';
import type { Orchestrator } from '../mcp/orchestrator.js';

// --- MCP log ring buffer ---
export interface MCPLogEntry {
  ts: number;
  level: 'info' | 'error';
  msg: string;
}

const MAX_LOG_ENTRIES = 200;
const mcpLogs: MCPLogEntry[] = [];

function mcpLog(level: 'info' | 'error', msg: string): void {
  const entry: MCPLogEntry = { ts: Date.now(), level, msg };
  mcpLogs.push(entry);
  if (mcpLogs.length > MAX_LOG_ENTRIES) mcpLogs.splice(0, mcpLogs.length - MAX_LOG_ENTRIES);
  console.log(`[MCP ${level}] ${msg}`);
}

export function getMCPLogs(): MCPLogEntry[] {
  return mcpLogs.slice();
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

interface RemoteServer {
  stop: () => Promise<void>;
  token: string;
  port: number;
  url: string;
  tailscaleUrl: string | null;
  wifiUrl: string | null;
  connectedClients: () => number;
}

/** Detect available network IPs (WiFi and Tailscale). */
function getNetworkIps(): { wifi: string | null; tailscale: string | null } {
  const nets = networkInterfaces();
  let wifi: string | null = null;
  let tailscale: string | null = null;

  for (const addrs of Object.values(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('100.')) {
        tailscale ??= addr.address;
      } else if (!addr.address.startsWith('172.')) {
        wifi ??= addr.address;
      }
    }
  }

  return { wifi, tailscale };
}

/** Build the agent list, deduplicated by taskId (keeps main agent per task). */
function buildAgentList(
  getTaskName: (taskId: string) => string,
  getAgentStatus: (agentId: string) => {
    status: 'running' | 'exited';
    exitCode: number | null;
    lastLine: string;
  },
): RemoteAgent[] {
  const byTask = new Map<string, RemoteAgent>();
  for (const agentId of getActiveAgentIds()) {
    const meta = getAgentMeta(agentId);
    if (!meta) continue;
    // Skip shell/sub-terminals — mobile should only show the main agent
    if (meta.isShell) continue;
    const info = getAgentStatus(agentId);
    const agent: RemoteAgent = {
      agentId,
      taskId: meta.taskId,
      taskName: getTaskName(meta.taskId),
      status: info.status,
      exitCode: info.exitCode,
      lastLine: info.lastLine,
    };
    // Prefer running agents over exited ones for the same task
    const existing = byTask.get(meta.taskId);
    if (!existing || (agent.status === 'running' && existing.status !== 'running')) {
      byTask.set(meta.taskId, agent);
    }
  }
  return Array.from(byTask.values());
}

export function startRemoteServer(opts: {
  port: number;
  staticDir: string;
  getTaskName: (taskId: string) => string;
  getAgentStatus: (agentId: string) => {
    status: 'running' | 'exited';
    exitCode: number | null;
    lastLine: string;
  };
  orchestrator?: Orchestrator;
}): RemoteServer {
  const token = randomBytes(24).toString('base64url');
  const ips = getNetworkIps();

  const tokenBuf = Buffer.from(token);

  function safeCompare(candidate: string | null | undefined): boolean {
    if (!candidate) return false;
    const buf = Buffer.from(candidate);
    if (buf.length !== tokenBuf.length) return false;
    return timingSafeEqual(buf, tokenBuf);
  }

  function checkAuth(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ') && safeCompare(auth.slice(7))) return true;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    return safeCompare(url.searchParams.get('token'));
  }

  const SECURITY_HEADERS: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // --- API routes (require auth) ---
    if (url.pathname.startsWith('/api/')) {
      if (!checkAuth(req)) {
        res.writeHead(401, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (url.pathname === '/api/agents' && req.method === 'GET') {
        const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
        return;
      }

      const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch && req.method === 'GET') {
        const agentId = agentMatch[1];
        const scrollback = getAgentScrollback(agentId);
        if (scrollback === null) {
          res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'agent not found' }));
          return;
        }
        const meta = getAgentMeta(agentId);
        const info = meta ? opts.getAgentStatus(agentId) : null;
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            agentId,
            scrollback,
            status: info?.status ?? 'exited',
            exitCode: info?.exitCode ?? null,
          }),
        );
        return;
      }

      // --- Orchestrator task API routes ---
      const orch = opts.orchestrator;
      if (orch) {
        // Helper to read JSON body
        const readBody = (): Promise<Record<string, unknown>> =>
          new Promise((resolve, reject) => {
            let data = '';
            req.on('data', (chunk: Buffer) => {
              data += chunk.toString();
              if (data.length > 1_000_000) {
                reject(new Error('Body too large'));
                req.destroy();
              }
            });
            req.on('end', () => {
              try {
                resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
              } catch {
                resolve({});
              }
            });
            req.on('error', reject);
          });

        const jsonReply = (status: number, body: unknown) => {
          res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };

        const taskIdMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(.+))?$/);

        if (url.pathname === '/api/tasks' && req.method === 'POST') {
          readBody()
            .then(async (body) => {
              mcpLog('info', `create_task name=${body.name as string}`);
              const result = await orch.createTask({
                name: body.name as string,
                prompt: body.prompt as string | undefined,
                coordinatorTaskId: (body.coordinatorTaskId as string) ?? 'api',
                projectId: body.projectId as string | undefined,
              });
              mcpLog('info', `create_task OK id=${result.id}`);
              jsonReply(201, orch.getTaskStatus(result.id));
            })
            .catch((err) => {
              mcpLog('error', `create_task FAIL: ${String(err)}`);
              jsonReply(500, { error: String(err) });
            });
          return;
        }

        if (url.pathname === '/api/tasks' && req.method === 'GET') {
          mcpLog('info', 'list_tasks');
          jsonReply(200, orch.listTasks());
          return;
        }

        if (taskIdMatch && !taskIdMatch[2] && req.method === 'GET') {
          const taskId = decodeURIComponent(taskIdMatch[1]);
          mcpLog('info', `get_task_status id=${taskId}`);
          const detail = orch.getTaskStatus(taskId);
          if (!detail) {
            jsonReply(404, { error: 'task not found' });
          } else {
            jsonReply(200, detail);
          }
          return;
        }

        if (taskIdMatch && taskIdMatch[2] === 'prompt' && req.method === 'POST') {
          readBody()
            .then(async (body) => {
              const taskId = decodeURIComponent(taskIdMatch[1]);
              mcpLog('info', `send_prompt id=${taskId}`);
              await orch.sendPrompt(taskId, body.prompt as string);
              jsonReply(200, { ok: true });
            })
            .catch((err) => {
              mcpLog('error', `send_prompt FAIL: ${String(err)}`);
              jsonReply(500, { error: String(err) });
            });
          return;
        }

        if (taskIdMatch && taskIdMatch[2] === 'wait' && req.method === 'POST') {
          readBody()
            .then(async (body) => {
              const taskId = decodeURIComponent(taskIdMatch[1]);
              mcpLog('info', `wait_for_idle id=${taskId}`);
              await orch.waitForIdle(taskId, body.timeoutMs as number | undefined);
              const status = orch.getTaskStatus(taskId);
              mcpLog('info', `wait_for_idle OK id=${taskId} status=${status?.status}`);
              jsonReply(200, { status: status?.status ?? 'unknown' });
            })
            .catch((err) => {
              mcpLog('error', `wait_for_idle FAIL: ${String(err)}`);
              jsonReply(500, { error: String(err) });
            });
          return;
        }

        if (taskIdMatch && taskIdMatch[2] === 'diff' && req.method === 'GET') {
          const taskId = decodeURIComponent(taskIdMatch[1]);
          mcpLog('info', `get_task_diff id=${taskId}`);
          orch
            .getTaskDiff(taskId)
            .then((result) => jsonReply(200, result))
            .catch((err) => {
              mcpLog('error', `get_task_diff FAIL: ${String(err)}`);
              jsonReply(500, { error: String(err) });
            });
          return;
        }

        if (taskIdMatch && taskIdMatch[2] === 'output' && req.method === 'GET') {
          const taskId = decodeURIComponent(taskIdMatch[1]);
          mcpLog('info', `get_task_output id=${taskId}`);
          try {
            const output = orch.getTaskOutput(taskId);
            jsonReply(200, { output });
          } catch (err) {
            mcpLog('error', `get_task_output FAIL: ${String(err)}`);
            jsonReply(500, { error: String(err) });
          }
          return;
        }

        if (taskIdMatch && taskIdMatch[2] === 'merge' && req.method === 'POST') {
          readBody()
            .then(async (body) => {
              const taskId = decodeURIComponent(taskIdMatch[1]);
              mcpLog('info', `merge_task id=${taskId} squash=${body.squash ?? false}`);
              const result = await orch.mergeTask(taskId, {
                squash: body.squash as boolean | undefined,
                message: body.message as string | undefined,
                cleanup: body.cleanup as boolean | undefined,
              });
              mcpLog('info', `merge_task OK id=${taskId}`);
              jsonReply(200, result);
            })
            .catch((err) => {
              mcpLog('error', `merge_task FAIL: ${String(err)}`);
              jsonReply(500, { error: String(err) });
            });
          return;
        }

        if (taskIdMatch && !taskIdMatch[2] && req.method === 'DELETE') {
          const taskId = decodeURIComponent(taskIdMatch[1]);
          mcpLog('info', `close_task id=${taskId}`);
          orch
            .closeTask(taskId)
            .then(() => {
              mcpLog('info', `close_task OK id=${taskId}`);
              jsonReply(200, { ok: true });
            })
            .catch((err) => {
              mcpLog('error', `close_task FAIL: ${String(err)}`);
              jsonReply(500, { error: String(err) });
            });
          return;
        }
      }

      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    // --- Static file serving for mobile SPA (async) ---
    const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const fullPath = resolve(opts.staticDir, filePath.replace(/^\/+/, ''));
    const rel = relative(opts.staticDir, fullPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      res.writeHead(400, SECURITY_HEADERS);
      res.end('Bad request');
      return;
    }

    const serveFile = (path: string, ct: string, cc: string) => {
      const stream = createReadStream(path);
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': ct, 'Cache-Control': cc });
      stream.pipe(res);
      stream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      });
    };

    if (!existsSync(fullPath)) {
      const indexPath = join(opts.staticDir, 'index.html');
      if (existsSync(indexPath)) {
        serveFile(indexPath, 'text/html', 'no-cache');
        return;
      }
      res.writeHead(404, SECURITY_HEADERS);
      res.end('Not found');
      return;
    }

    const ext = extname(fullPath);
    const contentType = MIME[ext] ?? 'application/octet-stream';
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
    serveFile(fullPath, contentType, cacheControl);
  });

  // --- WebSocket server ---
  const wss = new WebSocketServer({
    server,
    maxPayload: 64 * 1024,
    verifyClient: (info, cb) => {
      if (wss.clients.size >= 10) {
        cb(false, 429, 'Too many connections');
        return;
      }
      // Also accept token in URL query for backward compatibility, but
      // the preferred flow is first-message auth (avoids token in URL).
      cb(true);
    },
  });

  const clientSubs = new WeakMap<WebSocket, Map<string, (data: string) => void>>();
  const authenticatedClients = new Set<WebSocket>();
  const authTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>();

  function broadcast(msg: ServerMessage): void {
    const json = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && authenticatedClients.has(client)) {
        client.send(json);
      }
    }
  }

  const unsubSpawn = onPtyEvent('spawn', () => {
    const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
    broadcast({ type: 'agents', list });
  });

  const unsubListChanged = onPtyEvent('list-changed', () => {
    const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
    broadcast({ type: 'agents', list });
  });

  const unsubExit = onPtyEvent('exit', (agentId, data) => {
    const { exitCode } = (data ?? {}) as { exitCode?: number };
    broadcast({ type: 'status', agentId, status: 'exited', exitCode: exitCode ?? null });
    // Clean stale subscription entries from all connected clients
    for (const client of wss.clients) {
      clientSubs.get(client)?.delete(agentId);
    }
    setTimeout(() => {
      const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
      broadcast({ type: 'agents', list });
    }, 100);
  });

  wss.on('connection', (ws, req) => {
    clientSubs.set(ws, new Map());

    // Support legacy URL-based auth (verifyClient accepted all connections)
    if (checkAuth(req)) {
      authenticatedClients.add(ws);
      const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
      ws.send(JSON.stringify({ type: 'agents', list } satisfies ServerMessage));
    } else {
      // Close unauthenticated connections after 5 seconds
      const authTimer = setTimeout(() => {
        if (!authenticatedClients.has(ws)) {
          ws.close(4001, 'Auth timeout');
        }
      }, 5_000);
      authTimers.set(ws, authTimer);
    }

    ws.on('message', (raw) => {
      const msg = parseClientMessage(String(raw));
      if (!msg) return;

      // Handle first-message auth
      if (msg.type === 'auth') {
        if (safeCompare(msg.token)) {
          authenticatedClients.add(ws);
          const timer = authTimers.get(ws);
          if (timer) clearTimeout(timer);
          const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
          ws.send(JSON.stringify({ type: 'agents', list } satisfies ServerMessage));
        } else {
          ws.close(4001, 'Unauthorized');
        }
        return;
      }

      // Reject messages from unauthenticated clients
      if (!authenticatedClients.has(ws)) {
        ws.close(4001, 'Unauthorized');
        return;
      }

      switch (msg.type) {
        case 'input':
          try {
            writeToAgent(msg.agentId, msg.data);
          } catch {
            /* agent gone */
          }
          break;

        case 'resize':
          try {
            resizeAgent(msg.agentId, msg.cols, msg.rows);
          } catch {
            /* agent gone */
          }
          break;

        case 'kill':
          try {
            killAgent(msg.agentId);
          } catch {
            /* agent gone */
          }
          break;

        case 'subscribe': {
          const subs = clientSubs.get(ws);
          if (subs?.has(msg.agentId)) break;

          const scrollback = getAgentScrollback(msg.agentId);
          if (scrollback) {
            ws.send(
              JSON.stringify({
                type: 'scrollback',
                agentId: msg.agentId,
                data: scrollback,
                cols: getAgentCols(msg.agentId),
              } satisfies ServerMessage),
            );
          }

          const cb = (encoded: string) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: 'output',
                  agentId: msg.agentId,
                  data: encoded,
                } satisfies ServerMessage),
              );
            }
          };
          if (subscribeToAgent(msg.agentId, cb)) {
            subs?.set(msg.agentId, cb);
          }
          break;
        }

        case 'unsubscribe': {
          const subs = clientSubs.get(ws);
          const cb = subs?.get(msg.agentId);
          if (cb) {
            unsubscribeFromAgent(msg.agentId, cb);
            subs?.delete(msg.agentId);
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      authenticatedClients.delete(ws);
      const timer = authTimers.get(ws);
      if (timer) clearTimeout(timer);
      const subs = clientSubs.get(ws);
      if (subs) {
        for (const [agentId, cb] of subs) {
          unsubscribeFromAgent(agentId, cb);
        }
      }
    });
  });

  server.on('error', (err) => {
    console.error('[remote] Server error:', err.message);
  });
  server.listen(opts.port, '0.0.0.0', () => {
    /* bind confirmed */
  });

  const primaryIp = ips.wifi ?? ips.tailscale ?? '127.0.0.1';
  const url = `http://${primaryIp}:${opts.port}?token=${token}`;

  return {
    token,
    port: opts.port,
    url,
    /** Re-detect network IPs so newly connected interfaces (e.g. Tailscale) are picked up. */
    get wifiUrl() {
      const cur = getNetworkIps();
      return cur.wifi ? `http://${cur.wifi}:${opts.port}?token=${token}` : null;
    },
    get tailscaleUrl() {
      const cur = getNetworkIps();
      return cur.tailscale ? `http://${cur.tailscale}:${opts.port}?token=${token}` : null;
    },
    connectedClients: () => authenticatedClients.size,
    stop: () =>
      new Promise<void>((resolve) => {
        unsubSpawn();
        unsubExit();
        unsubListChanged();
        for (const client of wss.clients) client.close();
        wss.close();
        const timeout = setTimeout(() => resolve(), 5_000);
        server.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      }),
  };
}
