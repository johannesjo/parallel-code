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
import type { Coordinator } from '../mcp/coordinator.js';
import { validateBranchName } from '../mcp/validation.js';
import type { LandSelfInput, SubtaskVerification } from '../mcp/types.js';
import { AGENT_BACKENDS, isAgentBackend } from '../mcp/agent-backends.js';

// --- MCP log ring buffer ---
export interface MCPLogEntry {
  ts: number;
  level: 'info' | 'error';
  msg: string;
}

const MAX_LOG_ENTRIES = 200;
const REST_COORDINATOR_SENTINEL = 'api';
const MAX_REST_PROMPT_BYTES = 16 * 1024;
const mcpLogs: MCPLogEntry[] = [];

function mcpLog(level: 'info' | 'error', msg: string): void {
  const entry: MCPLogEntry = { ts: Date.now(), level, msg };
  mcpLogs.push(entry);
  if (mcpLogs.length > MAX_LOG_ENTRIES) mcpLogs.splice(0, mcpLogs.length - MAX_LOG_ENTRIES);
  console.warn(`[MCP ${level}] ${msg}`);
}

function sanitizePromptText(prompt: string): string {
  return (
    prompt
      // eslint-disable-next-line no-control-regex -- REST prompts are written to a PTY.
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .trim()
  );
}

function validateRestPrompt(
  value: unknown,
  required: boolean,
): string | undefined | { error: string } {
  if (value === undefined) {
    return required ? { error: 'prompt must be a non-empty string' } : undefined;
  }
  if (typeof value !== 'string')
    return { error: required ? 'prompt must be a non-empty string' : 'prompt must be a string' };
  const sanitized = sanitizePromptText(value);
  if (!sanitized) return required ? { error: 'prompt must be a non-empty string' } : undefined;
  if (Buffer.byteLength(sanitized, 'utf8') > MAX_REST_PROMPT_BYTES) {
    return { error: `prompt must be ${MAX_REST_PROMPT_BYTES} bytes or fewer` };
  }
  return sanitized;
}

export function getMCPLogs(): MCPLogEntry[] {
  return mcpLogs.slice();
}

function parseLandSelfInput(body: Record<string, unknown>): LandSelfInput | string {
  const summary = body.summary;
  if (summary !== undefined && typeof summary !== 'string') return 'summary must be a string';
  if (summary !== undefined && summary.length > 20_000)
    return 'summary must be 20000 characters or fewer';

  const verification = body.verification as { checks?: unknown } | undefined;
  if (!verification || typeof verification !== 'object') {
    return 'verification must be an object';
  }
  if (!Array.isArray(verification.checks) || verification.checks.length === 0) {
    return 'verification.checks must be a non-empty array';
  }
  if (verification.checks.length > 50) return 'verification.checks must contain 50 checks or fewer';

  const checks: SubtaskVerification['checks'] = [];
  for (const rawCheck of verification.checks) {
    if (!rawCheck || typeof rawCheck !== 'object') return 'verification checks must be objects';
    const check = rawCheck as Record<string, unknown>;
    if (typeof check.name !== 'string' || !check.name.trim()) {
      return 'verification check name must be a non-empty string';
    }
    if (typeof check.command !== 'string' || !check.command.trim()) {
      return 'verification check command must be a non-empty string';
    }
    if (check.result !== 'passed' && check.result !== 'blocked' && check.result !== 'failed') {
      return 'verification check result must be passed, blocked, or failed';
    }
    if (check.reason !== undefined && typeof check.reason !== 'string') {
      return 'verification check reason must be a string';
    }
    checks.push({
      name: check.name,
      command: check.command,
      result: check.result,
      reason: check.reason,
    });
  }

  return { verification: { checks }, summary };
}

/** Strip the token query param before logging or displaying a server URL. */
export function redactServerUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('token');
    return u.toString();
  } catch {
    return rawUrl;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

interface RemoteServer {
  stop: () => Promise<void>;
  token: string;
  subtaskToken: string;
  mobileToken: string;
  port: number;
  /** Mobile-scoped URL (embedded mobileToken). Safe to send to the renderer. */
  url: string;
  tailscaleUrl: string | null;
  wifiUrl: string | null;
  connectedClients: () => number;
  bindHost: string;
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
  host?: string;
  staticDir: string;
  getTaskName: (taskId: string) => string;
  getAgentStatus: (agentId: string) => {
    status: 'running' | 'exited';
    exitCode: number | null;
    lastLine: string;
  };
  getCoordinator: () => Coordinator | null;
}): Promise<RemoteServer> {
  const token = randomBytes(24).toString('base64url');
  const subtaskToken = randomBytes(24).toString('base64url');
  const mobileToken = randomBytes(24).toString('base64url');
  const ips = getNetworkIps();

  const tokenBuf = Buffer.from(token);
  const subtaskTokenBuf = Buffer.from(subtaskToken);
  const mobileTokenBuf = Buffer.from(mobileToken);

  function classifyCandidate(
    candidate: string | null | undefined,
  ): 'coordinator' | 'subtask' | 'mobile' | null {
    if (!candidate) return null;
    const buf = Buffer.from(candidate);
    if (buf.length === tokenBuf.length && timingSafeEqual(buf, tokenBuf)) return 'coordinator';
    if (buf.length === subtaskTokenBuf.length && timingSafeEqual(buf, subtaskTokenBuf))
      return 'subtask';
    if (buf.length === mobileTokenBuf.length && timingSafeEqual(buf, mobileTokenBuf))
      return 'mobile';
    return null;
  }

  function extractRawToken(req: IncomingMessage): string | null {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    return url.searchParams.get('token');
  }

  function classifyToken(req: IncomingMessage): 'coordinator' | 'subtask' | 'mobile' | null {
    return classifyCandidate(extractRawToken(req));
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
      const tokenClass = classifyToken(req);
      if (tokenClass === null) {
        res.writeHead(401, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (tokenClass === 'subtask') {
        const allowed =
          req.method === 'POST' && /^\/api\/tasks\/[^/]+\/(?:done|land)$/.test(url.pathname);
        if (!allowed) {
          res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
      }
      // Mobile token: read-only REST access to agent status only (terminal
      // input goes over the WebSocket, not REST).
      // Task/coordinator routes are intentionally excluded — the mobile view shows
      // agent terminals, not coordinator sub-tasks, and the mobile token is embedded
      // in a QR-code URL reachable by anyone on the local network.
      if (tokenClass === 'mobile') {
        const allowed =
          req.method === 'GET' &&
          (url.pathname === '/api/agents' || /^\/api\/agents\/[^/]+$/.test(url.pathname));
        if (!allowed) {
          res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
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

      // --- Coordinator task API routes ---
      const orch = opts.getCoordinator();
      const isCoordinatorRoute =
        url.pathname === '/api/tasks' ||
        url.pathname === '/api/wait-signal' ||
        url.pathname.startsWith('/api/tasks/');
      if (!orch && isCoordinatorRoute) {
        res.writeHead(503, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'coordinator not available' }));
        return;
      }
      if (orch) {
        // Helper to read JSON body
        const jsonReply = (status: number, body: unknown) => {
          if (res.headersSent) return;
          res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };

        const readBody = (): Promise<Record<string, unknown>> =>
          new Promise((resolve, reject) => {
            let data = '';
            req.on('data', (chunk: Buffer) => {
              data += chunk.toString();
              if (data.length > 1_000_000) {
                jsonReply(413, { error: 'Request body too large' });
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

        // Extract the coordinator ID from the header (set by MCP coordinator clients).
        // Only honor it if it is a registered coordinator — prevents a caller from
        // injecting an arbitrary ID to scope against another coordinator's tasks.
        const callerCoordinatorId = (() => {
          const h = req.headers['x-coordinator-id'];
          if (typeof h !== 'string' || !h) return undefined;
          return orch.isRegisteredCoordinator(h) ? h : undefined;
        })();

        // Coordinator-class tokens must include a valid X-Coordinator-Id so they can
        // only access their own tasks. Without it, a stolen coordinator token could
        // list and control all coordinators' tasks. This guard applies to ALL
        // coordinator routes including wait-signal.
        if (tokenClass === 'coordinator' && !callerCoordinatorId) {
          jsonReply(403, { error: 'X-Coordinator-Id header required for task routes' });
          return;
        }

        const ownedByCallerOrUnscoped = (taskCoordinatorId: string): boolean =>
          !callerCoordinatorId || taskCoordinatorId === callerCoordinatorId;

        // Fetch a task by id, replying 404 (missing) or 403 (not owned) and
        // returning null in those cases. Centralizes the per-route ownership gate.
        const requireOwnedTask = (taskId: string) => {
          const detail = orch.getTaskStatus(taskId);
          if (!detail) {
            jsonReply(404, { error: 'task not found' });
            return null;
          }
          if (!ownedByCallerOrUnscoped(detail.coordinatorTaskId)) {
            jsonReply(403, { error: 'forbidden' });
            return null;
          }
          return detail;
        };

        const hasMatchingDoneToken = (taskId: string): boolean => {
          const expected = orch.getTaskDoneToken(taskId);
          const incoming = req.headers['x-done-token'];
          return Boolean(
            expected &&
            typeof incoming === 'string' &&
            incoming.length === expected.length &&
            timingSafeEqual(Buffer.from(incoming), Buffer.from(expected)),
          );
        };

        const taskIdMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(.+))?$/);

        if (url.pathname === '/api/wait-signal' && req.method === 'POST') {
          readBody()
            .then(async (body) => {
              // Use the verified header coordinator ID exclusively — any caller with
              // a valid coordinator token must supply X-Coordinator-Id (enforced above).
              // Ignoring the body field matches the create_task pattern and prevents
              // an unscoped body value from flowing unchecked to waitForSignalDone.
              const coordinatorTaskId = callerCoordinatorId ?? REST_COORDINATOR_SENTINEL;
              if (
                body.timeoutMs !== undefined &&
                (typeof body.timeoutMs !== 'number' || !Number.isFinite(body.timeoutMs))
              )
                return jsonReply(400, { error: 'timeoutMs must be a finite number' });
              const requestId = typeof body.requestId === 'string' ? body.requestId : undefined;
              mcpLog('info', `wait_for_signal_done coordinator=${coordinatorTaskId}`);
              const result = await orch.waitForSignalDone(
                coordinatorTaskId,
                body.timeoutMs as number | undefined,
                requestId,
              );
              mcpLog(
                'info',
                `wait_for_signal_done OK taskId=${result.taskId} remaining=${result.remaining}`,
              );
              jsonReply(200, result);
            })
            .catch((err) => {
              mcpLog('error', `wait_for_signal_done FAIL: ${String(err)}`);
              jsonReply(500, { error: String(err) });
            });
          return;
        }

        if (url.pathname === '/api/tasks' && req.method === 'POST') {
          readBody()
            .then(async (body) => {
              if (typeof body.name !== 'string' || !body.name)
                return jsonReply(400, { error: 'name must be a non-empty string' });
              if (body.name.length > 200)
                return jsonReply(400, { error: 'name must be 200 characters or fewer' });
              // Strip control characters to prevent prompt injection via task name
              // appearing verbatim in coordinator notification messages.
              // eslint-disable-next-line no-control-regex
              body.name = (body.name as string).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
              if (!body.name) return jsonReply(400, { error: 'name must be a non-empty string' });
              const prompt = validateRestPrompt(body.prompt, true);
              if (typeof prompt !== 'string') return jsonReply(400, prompt);
              if (body.projectId !== undefined && typeof body.projectId !== 'string')
                return jsonReply(400, { error: 'projectId must be a string' });
              if (body.gitIsolation !== undefined)
                return jsonReply(400, {
                  error: 'gitIsolation is not supported; only worktree isolation is implemented',
                });
              let baseBranch: string | undefined;
              if (body.baseBranch !== undefined) {
                try {
                  baseBranch = validateBranchName(body.baseBranch, 'baseBranch');
                } catch (e) {
                  return jsonReply(400, { error: String(e) });
                }
              }
              let backend: string | undefined;
              if (body.backend !== undefined) {
                if (!isAgentBackend(body.backend)) {
                  return jsonReply(400, {
                    error: `backend must be one of: ${AGENT_BACKENDS.join(', ')}`,
                  });
                }
                backend = body.backend;
              }
              // For coordinator-token callers, the authoritative coordinator ID is
              // the verified X-Coordinator-Id header (callerCoordinatorId). Reject
              // any body value that tries to create a task under a different coordinator,
              // since that would let coordinator A impersonate coordinator B.
              if (
                callerCoordinatorId &&
                typeof body.coordinatorTaskId === 'string' &&
                body.coordinatorTaskId !== callerCoordinatorId
              ) {
                return jsonReply(403, {
                  error: 'coordinatorTaskId in body does not match X-Coordinator-Id header',
                });
              }
              const coordinatorTaskId = callerCoordinatorId ?? REST_COORDINATOR_SENTINEL;
              mcpLog(
                'info',
                `create_task name=${body.name} baseBranch=${baseBranch ?? 'default'} promptBytes=${Buffer.byteLength(prompt, 'utf8')}`,
              );
              const result = await orch.createTask({
                name: body.name as string,
                prompt,
                coordinatorTaskId,
                projectId: body.projectId as string | undefined,
                baseBranch,
                backend,
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
          const all = orch.listTasks();
          const tasks = callerCoordinatorId
            ? all.filter((t) => t.coordinatorTaskId === callerCoordinatorId)
            : all;
          jsonReply(200, tasks);
          return;
        }

        if (taskIdMatch && !taskIdMatch[2] && req.method === 'GET') {
          const taskId = decodeURIComponent(taskIdMatch[1]);
          mcpLog('info', `get_task_status id=${taskId}`);
          const detail = requireOwnedTask(taskId);
          if (detail) jsonReply(200, detail);
          return;
        }

        if (taskIdMatch && taskIdMatch[2] === 'prompt' && req.method === 'POST') {
          readBody()
            .then(async (body) => {
              const taskId = decodeURIComponent(taskIdMatch[1]);
              const prompt = validateRestPrompt(body.prompt, true);
              if (!prompt || typeof prompt !== 'string') return jsonReply(400, prompt);
              if (!requireOwnedTask(taskId)) return;
              mcpLog('info', `send_prompt id=${taskId}`);
              const result = await orch.sendPrompt(taskId, prompt);
              jsonReply(200, { ok: true, ...result });
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
              if (
                body.timeoutMs !== undefined &&
                (typeof body.timeoutMs !== 'number' || !Number.isFinite(body.timeoutMs))
              )
                return jsonReply(400, { error: 'timeoutMs must be a finite number' });
              if (!requireOwnedTask(taskId)) return;
              mcpLog('info', `wait_for_idle id=${taskId}`);
              const idleResult = await orch.waitForIdle(
                taskId,
                body.timeoutMs as number | undefined,
              );
              const status = orch.getTaskStatus(taskId);
              mcpLog(
                'info',
                `wait_for_idle OK id=${taskId} status=${status?.status} reason=${idleResult.reason}`,
              );
              jsonReply(200, { status: status?.status ?? 'unknown', reason: idleResult.reason });
            })
            .catch((err) => {
              mcpLog('error', `wait_for_idle FAIL: ${String(err)}`);
              jsonReply(500, { error: String(err) });
            });
          return;
        }

        if (taskIdMatch && taskIdMatch[2] === 'review-merge' && req.method === 'POST') {
          readBody()
            .then(async (body) => {
              const taskId = decodeURIComponent(taskIdMatch[1]);
              if (body.squash !== undefined && typeof body.squash !== 'boolean')
                return jsonReply(400, { error: 'squash must be a boolean' });
              if (body.message !== undefined && typeof body.message !== 'string')
                return jsonReply(400, { error: 'message must be a string' });
              if (!requireOwnedTask(taskId)) return;
              mcpLog('info', `review_and_merge_task id=${taskId}`);
              const result = await orch.reviewAndMergeTask(taskId, {
                squash: body.squash as boolean | undefined,
                message: body.message as string | undefined,
              });
              mcpLog('info', `review_and_merge_task OK id=${taskId}`);
              jsonReply(200, result);
            })
            .catch((err) => {
              mcpLog('error', `review_and_merge_task FAIL: ${String(err)}`);
              jsonReply(500, { error: String(err) });
            });
          return;
        }

        if (taskIdMatch && taskIdMatch[2] === 'diff' && req.method === 'GET') {
          const taskId = decodeURIComponent(taskIdMatch[1]);
          if (!requireOwnedTask(taskId)) return;
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
          if (!requireOwnedTask(taskId)) return;
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

        if (taskIdMatch && taskIdMatch[2] === 'done' && req.method === 'POST') {
          const taskId = decodeURIComponent(taskIdMatch[1]);
          if (!requireOwnedTask(taskId)) return;
          // Subtask callers must provide the per-task X-Done-Token header so a compromised
          // sub-task cannot signal completion for tasks it doesn't own.
          // Coordinator-class callers are intentionally exempt: a coordinator token is
          // scoped to its own sub-tasks via callerCoordinatorId (enforced above), and
          // trusting coordinators to call signal_done on their children matches the
          // intended authority model. The done-token is a sub-task ownership proof, not
          // a coordinator authority proof.
          if (tokenClass === 'subtask') {
            if (!hasMatchingDoneToken(taskId)) {
              return jsonReply(403, { error: 'forbidden' });
            }
          }
          mcpLog('info', `signal_done id=${taskId}`);
          orch.signalDone(taskId);
          jsonReply(200, { ok: true });
          return;
        }

        if (taskIdMatch && taskIdMatch[2] === 'land' && req.method === 'POST') {
          readBody()
            .then(async (body) => {
              const taskId = decodeURIComponent(taskIdMatch[1]);
              const landDetail = orch.getTaskStatus(taskId);
              if (!landDetail) return jsonReply(404, { error: 'task not found' });
              if (tokenClass !== 'subtask') return jsonReply(403, { error: 'forbidden' });
              if (!hasMatchingDoneToken(taskId)) return jsonReply(403, { error: 'forbidden' });

              const parsed = parseLandSelfInput(body);
              if (typeof parsed === 'string') return jsonReply(400, { error: parsed });

              mcpLog('info', `land_self id=${taskId}`);
              const result = await orch.landSelf(taskId, parsed);
              mcpLog('info', `land_self OK id=${taskId}`);
              jsonReply(200, result);
            })
            .catch((err) => {
              mcpLog('error', `land_self FAIL: ${String(err)}`);
              jsonReply(500, { error: String(err) });
            });
          return;
        }

        if (taskIdMatch && taskIdMatch[2] === 'merge' && req.method === 'POST') {
          readBody()
            .then(async (body) => {
              const taskId = decodeURIComponent(taskIdMatch[1]);
              if (body.squash !== undefined && typeof body.squash !== 'boolean')
                return jsonReply(400, { error: 'squash must be a boolean' });
              if (body.message !== undefined && typeof body.message !== 'string')
                return jsonReply(400, { error: 'message must be a string' });
              if (body.cleanup !== undefined && typeof body.cleanup !== 'boolean')
                return jsonReply(400, { error: 'cleanup must be a boolean' });
              if (!requireOwnedTask(taskId)) return;
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
          if (!requireOwnedTask(taskId)) return;
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
    // HTML and the web manifest must revalidate so app/manifest changes reach
    // already-installed PWA clients. Icons live at stable (non-content-hashed)
    // URLs, so cache them briefly rather than immutably. Only Vite's hashed
    // JS/CSS bundles are safe to pin immutable for a year.
    let cacheControl: string;
    if (ext === '.html' || ext === '.webmanifest') {
      cacheControl = 'no-cache';
    } else if (ext === '.png' || ext === '.svg' || ext === '.ico') {
      cacheControl = 'public, max-age=86400';
    } else {
      cacheControl = 'public, max-age=31536000, immutable';
    }
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
  const clientTokenTypes = new Map<WebSocket, 'coordinator' | 'mobile'>();
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

    // Support legacy URL-based auth (verifyClient accepted all connections).
    // Only coordinator token grants WS access; subtask and mobile tokens are denied.
    if (classifyToken(req) === 'coordinator') {
      authenticatedClients.add(ws);
      clientTokenTypes.set(ws, 'coordinator');
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

      // Handle first-message auth. Coordinator and mobile tokens grant WS
      // access; subtask tokens are denied.
      if (msg.type === 'auth') {
        const tokenType = classifyCandidate(msg.token);
        if (tokenType === 'coordinator' || tokenType === 'mobile') {
          authenticatedClients.add(ws);
          clientTokenTypes.set(ws, tokenType);
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

      // Mobile clients may type into agent terminals (`input`) but cannot
      // resize the PTY (desktop owns the geometry) or kill agents — the
      // mobile token travels in a QR-code URL, so keep its blast radius small.
      if (clientTokenTypes.get(ws) === 'mobile') {
        if (msg.type === 'resize' || msg.type === 'kill') {
          ws.close(4003, 'Forbidden');
          return;
        }
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
      clientTokenTypes.delete(ws);
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

  const bindHost = opts.host ?? '0.0.0.0';

  server.on('error', (err) => {
    console.error('[remote] Server error:', err.message);
  });

  const primaryIp = ips.wifi ?? ips.tailscale ?? '127.0.0.1';
  // url embeds the mobileToken — safe to surface in UI. Coordinator token never leaves the main process.
  const url = `http://${primaryIp}:${opts.port}?token=${mobileToken}`;

  const result: RemoteServer = {
    token,
    subtaskToken,
    mobileToken,
    port: opts.port,
    bindHost,
    url,
    /** Re-detect network IPs so newly connected interfaces (e.g. Tailscale) are picked up. */
    get wifiUrl() {
      const cur = getNetworkIps();
      return cur.wifi ? `http://${cur.wifi}:${opts.port}?token=${mobileToken}` : null;
    },
    get tailscaleUrl() {
      const cur = getNetworkIps();
      return cur.tailscale ? `http://${cur.tailscale}:${opts.port}?token=${mobileToken}` : null;
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

  return new Promise<RemoteServer>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(opts.port, bindHost, () => {
      server.removeListener('error', onError);
      // Capture the actual bound port (important when opts.port === 0)
      const addr = server.address();
      if (addr && typeof addr === 'object') result.port = addr.port;
      resolve(result);
    });
  });
}
