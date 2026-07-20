// electron/remote/server.ts

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { existsSync, createReadStream } from 'fs';
import { join, resolve, relative, extname, isAbsolute } from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, randomInt, timingSafeEqual } from 'crypto';
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
import {
  parseClientMessage,
  type ServerMessage,
  type RemoteAgent,
  type RemoteAttentionState,
} from './protocol.js';
import type { Coordinator } from '../mcp/coordinator.js';
import { validateBranchName } from '../mcp/validation.js';
import type { ApiTaskDetail, LandSelfInput, SubtaskVerification } from '../mcp/types.js';

// --- MCP log ring buffer ---
export interface MCPLogEntry {
  ts: number;
  level: 'info' | 'error';
  msg: string;
}

const MAX_LOG_ENTRIES = 200;
const REST_COORDINATOR_SENTINEL = 'api';
const MAX_REST_PROMPT_BYTES = 16 * 1024;
const MAX_NOTES_BYTES = 100 * 1024;
// Device pairing: a mobile client proves it can see the desktop by entering a
// short-lived PIN, which elevates it to a "paired" token allowed to create tasks.
const PAIRING_PIN_TTL_MS = 5 * 60_000;
const PAIRING_MAX_ATTEMPTS = 5;
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

/**
 * Map a server `listen` error to a friendlier one for the UI, turning the
 * cryptic "listen EADDRINUSE 0.0.0.0:7777" into actionable text. Preserves
 * `.code` so the MCP free-port scan can still detect EADDRINUSE and retry.
 */
export function toFriendlyListenError(
  err: NodeJS.ErrnoException,
  port: number,
): NodeJS.ErrnoException {
  if (err.code === 'EADDRINUSE') {
    const friendly = new Error(
      `Port ${port} is already in use — another Parallel Code instance may be running. ` +
        `Close it or free the port, then try again.`,
    ) as NodeJS.ErrnoException;
    friendly.code = 'EADDRINUSE';
    return friendly;
  }
  return err;
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
  /** Mint a fresh pairing PIN (shown on the desktop) for a phone to enter. */
  generatePairingPin: () => { pin: string; expiresAt: number };
}

/** A project the mobile "New Task" screen can target. */
export interface RemoteProject {
  id: string;
  name: string;
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
  getTaskAttention: (taskId: string) => RemoteAttentionState,
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
      attention: getTaskAttention(meta.taskId),
    };
    // Prefer running agents over exited ones for the same task
    const existing = byTask.get(meta.taskId);
    if (!existing || (agent.status === 'running' && existing.status !== 'running')) {
      byTask.set(meta.taskId, agent);
    }
  }
  return Array.from(byTask.values());
}

/** Read and JSON-parse a request body with a hard size cap. */
function readJsonBody(
  req: IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        // Reject but keep draining: destroying the socket here would tear down
        // the connection before the caller's error reply (e.g. 413) can be
        // written, and the client would see a reset instead of the response.
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      // Decode once from the full buffer so a multi-byte UTF-8 char split
      // across chunk boundaries isn't corrupted (matters for non-ASCII prompts).
      const data = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

export type JsonReply = (status: number, body: unknown) => void;

type TokenClass = 'coordinator' | 'subtask' | 'mobile' | 'paired';

export function createJsonReply(
  res: ServerResponse,
  securityHeaders: Record<string, string>,
): JsonReply {
  return (status: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

export async function readCoordinatorBody(
  req: IncomingMessage,
  jsonReply: JsonReply,
): Promise<Record<string, unknown>> {
  try {
    return await readJsonBody(req, 1_000_000);
  } catch (err) {
    if (err instanceof Error && err.message === 'Body too large') {
      jsonReply(413, { error: 'Request body too large' });
    }
    throw err;
  }
}

export function requireOwnedTask(
  orch: Coordinator,
  taskId: string,
  callerCoordinatorId: string | undefined,
  jsonReply: JsonReply,
): ApiTaskDetail | null {
  const detail = orch.getTaskStatus(taskId);
  if (!detail) {
    jsonReply(404, { error: 'task not found' });
    return null;
  }
  if (callerCoordinatorId && detail.coordinatorTaskId !== callerCoordinatorId) {
    jsonReply(403, { error: 'forbidden' });
    return null;
  }
  return detail;
}

/** Shared per-request context passed to every coordinator route handler. */
interface CoordinatorRouteContext {
  orch: Coordinator;
  tokenClass: TokenClass | null;
  callerCoordinatorId: string | undefined;
  jsonReply: JsonReply;
  readBody: () => Promise<Record<string, unknown>>;
  requireTask: (taskId: string) => ApiTaskDetail | null;
  hasMatchingDoneToken: (taskId: string) => boolean;
}

function handleWaitSignal(ctx: CoordinatorRouteContext): void {
  ctx
    .readBody()
    .then(async (body) => {
      // Use the verified header coordinator ID exclusively — any caller with
      // a valid coordinator token must supply X-Coordinator-Id (enforced above).
      // Ignoring the body field matches the create_task pattern and prevents
      // an unscoped body value from flowing unchecked to waitForSignalDone.
      const coordinatorTaskId = ctx.callerCoordinatorId ?? REST_COORDINATOR_SENTINEL;
      if (
        body.timeoutMs !== undefined &&
        (typeof body.timeoutMs !== 'number' || !Number.isFinite(body.timeoutMs))
      )
        return ctx.jsonReply(400, { error: 'timeoutMs must be a finite number' });
      const requestId = typeof body.requestId === 'string' ? body.requestId : undefined;
      mcpLog('info', `wait_for_signal_done coordinator=${coordinatorTaskId}`);
      const result = await ctx.orch.waitForSignalDone(
        coordinatorTaskId,
        body.timeoutMs as number | undefined,
        requestId,
      );
      mcpLog(
        'info',
        `wait_for_signal_done OK taskId=${result.taskId} remaining=${result.remaining}`,
      );
      ctx.jsonReply(200, result);
    })
    .catch((err) => {
      mcpLog('error', `wait_for_signal_done FAIL: ${String(err)}`);
      ctx.jsonReply(500, { error: String(err) });
    });
}

function handleCreateTask(ctx: CoordinatorRouteContext): void {
  ctx
    .readBody()
    .then(async (body) => {
      if (typeof body.name !== 'string' || !body.name)
        return ctx.jsonReply(400, { error: 'name must be a non-empty string' });
      if (body.name.length > 200)
        return ctx.jsonReply(400, { error: 'name must be 200 characters or fewer' });
      // Strip control characters to prevent prompt injection via task name
      // appearing verbatim in coordinator notification messages.
      // eslint-disable-next-line no-control-regex
      body.name = (body.name as string).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
      if (!body.name) return ctx.jsonReply(400, { error: 'name must be a non-empty string' });
      const prompt = validateRestPrompt(body.prompt, true);
      if (typeof prompt !== 'string') return ctx.jsonReply(400, prompt);
      if (body.projectId !== undefined && typeof body.projectId !== 'string')
        return ctx.jsonReply(400, { error: 'projectId must be a string' });
      if (body.gitIsolation !== undefined)
        return ctx.jsonReply(400, {
          error: 'gitIsolation is not supported; only worktree isolation is implemented',
        });
      let baseBranch: string | undefined;
      if (body.baseBranch !== undefined) {
        try {
          baseBranch = validateBranchName(body.baseBranch, 'baseBranch');
        } catch (e) {
          return ctx.jsonReply(400, { error: String(e) });
        }
      }
      // For coordinator-token callers, the authoritative coordinator ID is
      // the verified X-Coordinator-Id header (callerCoordinatorId). Reject
      // any body value that tries to create a task under a different coordinator,
      // since that would let coordinator A impersonate coordinator B.
      if (
        ctx.callerCoordinatorId &&
        typeof body.coordinatorTaskId === 'string' &&
        body.coordinatorTaskId !== ctx.callerCoordinatorId
      ) {
        return ctx.jsonReply(403, {
          error: 'coordinatorTaskId in body does not match X-Coordinator-Id header',
        });
      }
      const coordinatorTaskId = ctx.callerCoordinatorId ?? REST_COORDINATOR_SENTINEL;
      mcpLog(
        'info',
        `create_task name=${body.name} baseBranch=${baseBranch ?? 'default'} promptBytes=${Buffer.byteLength(prompt, 'utf8')}`,
      );
      const result = await ctx.orch.createTask({
        name: body.name as string,
        prompt,
        coordinatorTaskId,
        projectId: body.projectId as string | undefined,
        baseBranch,
      });
      mcpLog('info', `create_task OK id=${result.id}`);
      ctx.jsonReply(201, ctx.orch.getTaskStatus(result.id));
    })
    .catch((err) => {
      mcpLog('error', `create_task FAIL: ${String(err)}`);
      ctx.jsonReply(500, { error: String(err) });
    });
}

function handleListTasks(ctx: CoordinatorRouteContext): void {
  mcpLog('info', 'list_tasks');
  const all = ctx.orch.listTasks();
  const tasks = ctx.callerCoordinatorId
    ? all.filter((t) => t.coordinatorTaskId === ctx.callerCoordinatorId)
    : all;
  ctx.jsonReply(200, tasks);
}

function handleGetTaskStatus(ctx: CoordinatorRouteContext, taskId: string): void {
  mcpLog('info', `get_task_status id=${taskId}`);
  const detail = ctx.requireTask(taskId);
  if (detail) ctx.jsonReply(200, detail);
}

function handleSendPrompt(ctx: CoordinatorRouteContext, taskId: string): void {
  ctx
    .readBody()
    .then(async (body) => {
      const prompt = validateRestPrompt(body.prompt, true);
      if (!prompt || typeof prompt !== 'string') return ctx.jsonReply(400, prompt);
      if (!ctx.requireTask(taskId)) return;
      mcpLog('info', `send_prompt id=${taskId}`);
      const result = await ctx.orch.sendPrompt(taskId, prompt);
      ctx.jsonReply(200, { ok: true, ...result });
    })
    .catch((err) => {
      mcpLog('error', `send_prompt FAIL: ${String(err)}`);
      ctx.jsonReply(500, { error: String(err) });
    });
}

function handleWaitForIdle(ctx: CoordinatorRouteContext, taskId: string): void {
  ctx
    .readBody()
    .then(async (body) => {
      if (
        body.timeoutMs !== undefined &&
        (typeof body.timeoutMs !== 'number' || !Number.isFinite(body.timeoutMs))
      )
        return ctx.jsonReply(400, { error: 'timeoutMs must be a finite number' });
      if (!ctx.requireTask(taskId)) return;
      mcpLog('info', `wait_for_idle id=${taskId}`);
      const idleResult = await ctx.orch.waitForIdle(taskId, body.timeoutMs as number | undefined);
      const status = ctx.orch.getTaskStatus(taskId);
      mcpLog(
        'info',
        `wait_for_idle OK id=${taskId} status=${status?.status} reason=${idleResult.reason}`,
      );
      ctx.jsonReply(200, { status: status?.status ?? 'unknown', reason: idleResult.reason });
    })
    .catch((err) => {
      mcpLog('error', `wait_for_idle FAIL: ${String(err)}`);
      ctx.jsonReply(500, { error: String(err) });
    });
}

function handleReviewAndMerge(ctx: CoordinatorRouteContext, taskId: string): void {
  ctx
    .readBody()
    .then(async (body) => {
      if (body.squash !== undefined && typeof body.squash !== 'boolean')
        return ctx.jsonReply(400, { error: 'squash must be a boolean' });
      if (body.message !== undefined && typeof body.message !== 'string')
        return ctx.jsonReply(400, { error: 'message must be a string' });
      if (!ctx.requireTask(taskId)) return;
      mcpLog('info', `review_and_merge_task id=${taskId}`);
      const result = await ctx.orch.reviewAndMergeTask(taskId, {
        squash: body.squash as boolean | undefined,
        message: body.message as string | undefined,
      });
      mcpLog('info', `review_and_merge_task OK id=${taskId}`);
      ctx.jsonReply(200, result);
    })
    .catch((err) => {
      mcpLog('error', `review_and_merge_task FAIL: ${String(err)}`);
      ctx.jsonReply(500, { error: String(err) });
    });
}

function handleGetTaskDiff(ctx: CoordinatorRouteContext, taskId: string): void {
  if (!ctx.requireTask(taskId)) return;
  mcpLog('info', `get_task_diff id=${taskId}`);
  ctx.orch
    .getTaskDiff(taskId)
    .then((result) => ctx.jsonReply(200, result))
    .catch((err) => {
      mcpLog('error', `get_task_diff FAIL: ${String(err)}`);
      ctx.jsonReply(500, { error: String(err) });
    });
}

function handleGetTaskOutput(ctx: CoordinatorRouteContext, taskId: string): void {
  if (!ctx.requireTask(taskId)) return;
  mcpLog('info', `get_task_output id=${taskId}`);
  try {
    const output = ctx.orch.getTaskOutput(taskId);
    ctx.jsonReply(200, { output });
  } catch (err) {
    mcpLog('error', `get_task_output FAIL: ${String(err)}`);
    ctx.jsonReply(500, { error: String(err) });
  }
}

function handleSignalDone(ctx: CoordinatorRouteContext, taskId: string): void {
  if (!ctx.requireTask(taskId)) return;
  // Subtask callers must provide the per-task X-Done-Token header so a compromised
  // sub-task cannot signal completion for tasks it doesn't own.
  // Coordinator-class callers are intentionally exempt: a coordinator token is
  // scoped to its own sub-tasks via callerCoordinatorId (enforced above), and
  // trusting coordinators to call signal_done on their children matches the
  // intended authority model. The done-token is a sub-task ownership proof, not
  // a coordinator authority proof.
  if (ctx.tokenClass === 'subtask') {
    if (!ctx.hasMatchingDoneToken(taskId)) {
      return ctx.jsonReply(403, { error: 'forbidden' });
    }
  }
  mcpLog('info', `signal_done id=${taskId}`);
  ctx.orch.signalDone(taskId);
  ctx.jsonReply(200, { ok: true });
}

function handleLandSelf(ctx: CoordinatorRouteContext, taskId: string): void {
  ctx
    .readBody()
    .then(async (body) => {
      const landDetail = ctx.orch.getTaskStatus(taskId);
      if (!landDetail) return ctx.jsonReply(404, { error: 'task not found' });
      if (ctx.tokenClass !== 'subtask') return ctx.jsonReply(403, { error: 'forbidden' });
      if (!ctx.hasMatchingDoneToken(taskId)) return ctx.jsonReply(403, { error: 'forbidden' });

      const parsed = parseLandSelfInput(body);
      if (typeof parsed === 'string') return ctx.jsonReply(400, { error: parsed });

      mcpLog('info', `land_self id=${taskId}`);
      const result = await ctx.orch.landSelf(taskId, parsed);
      mcpLog('info', `land_self OK id=${taskId}`);
      ctx.jsonReply(200, result);
    })
    .catch((err) => {
      mcpLog('error', `land_self FAIL: ${String(err)}`);
      ctx.jsonReply(500, { error: String(err) });
    });
}

function handleMergeTask(ctx: CoordinatorRouteContext, taskId: string): void {
  ctx
    .readBody()
    .then(async (body) => {
      if (body.squash !== undefined && typeof body.squash !== 'boolean')
        return ctx.jsonReply(400, { error: 'squash must be a boolean' });
      if (body.message !== undefined && typeof body.message !== 'string')
        return ctx.jsonReply(400, { error: 'message must be a string' });
      if (body.cleanup !== undefined && typeof body.cleanup !== 'boolean')
        return ctx.jsonReply(400, { error: 'cleanup must be a boolean' });
      if (!ctx.requireTask(taskId)) return;
      mcpLog('info', `merge_task id=${taskId} squash=${body.squash ?? false}`);
      const result = await ctx.orch.mergeTask(taskId, {
        squash: body.squash as boolean | undefined,
        message: body.message as string | undefined,
        cleanup: body.cleanup as boolean | undefined,
      });
      mcpLog('info', `merge_task OK id=${taskId}`);
      ctx.jsonReply(200, result);
    })
    .catch((err) => {
      mcpLog('error', `merge_task FAIL: ${String(err)}`);
      ctx.jsonReply(500, { error: String(err) });
    });
}

function handleCloseTask(ctx: CoordinatorRouteContext, taskId: string): void {
  if (!ctx.requireTask(taskId)) return;
  mcpLog('info', `close_task id=${taskId}`);
  ctx.orch
    .closeTask(taskId)
    .then(() => {
      mcpLog('info', `close_task OK id=${taskId}`);
      ctx.jsonReply(200, { ok: true });
    })
    .catch((err) => {
      mcpLog('error', `close_task FAIL: ${String(err)}`);
      ctx.jsonReply(500, { error: String(err) });
    });
}

/** Routes with no task ID in the path: list/create tasks, wait-signal. */
const COORDINATOR_ROOT_ROUTES: Array<{
  pathname: string;
  method: string;
  handler: (ctx: CoordinatorRouteContext) => void;
}> = [
  { pathname: '/api/wait-signal', method: 'POST', handler: handleWaitSignal },
  { pathname: '/api/tasks', method: 'POST', handler: handleCreateTask },
  { pathname: '/api/tasks', method: 'GET', handler: handleListTasks },
];

/** Routes scoped to `/api/tasks/:taskId[/subpath]`, keyed by subpath + method. */
const COORDINATOR_TASK_ROUTES: Array<{
  subpath: string | null;
  method: string;
  handler: (ctx: CoordinatorRouteContext, taskId: string) => void;
}> = [
  { subpath: null, method: 'GET', handler: handleGetTaskStatus },
  { subpath: 'prompt', method: 'POST', handler: handleSendPrompt },
  { subpath: 'wait', method: 'POST', handler: handleWaitForIdle },
  { subpath: 'review-merge', method: 'POST', handler: handleReviewAndMerge },
  { subpath: 'diff', method: 'GET', handler: handleGetTaskDiff },
  { subpath: 'output', method: 'GET', handler: handleGetTaskOutput },
  { subpath: 'done', method: 'POST', handler: handleSignalDone },
  { subpath: 'land', method: 'POST', handler: handleLandSelf },
  { subpath: 'merge', method: 'POST', handler: handleMergeTask },
  { subpath: null, method: 'DELETE', handler: handleCloseTask },
];

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
  /** List projects the mobile "New Task" screen can target (renderer-backed). */
  getProjects?: () => Promise<RemoteProject[]>;
  /** Create a top-level task on behalf of a paired phone (renderer-backed). */
  createTaskFromMobile?: (req: {
    projectId: string;
    name: string;
    prompt: string;
  }) => Promise<{ taskId: string }>;
  /** Read a task's notes (renderer-backed). */
  getTaskNotes?: (taskId: string) => Promise<string>;
  /** Persist a task's notes (renderer-backed). */
  setTaskNotes?: (taskId: string, notes: string) => Promise<void>;
  /** Renderer-derived task attention state (needs input, working, ready, …). */
  getTaskAttention?: (taskId: string) => RemoteAttentionState;
}): Promise<RemoteServer> {
  // Fall back to 'idle' when the caller doesn't wire attention (e.g. MCP-only start).
  const getTaskAttention: (taskId: string) => RemoteAttentionState =
    opts.getTaskAttention ?? (() => 'idle');
  const token = randomBytes(24).toString('base64url');
  const subtaskToken = randomBytes(24).toString('base64url');
  const mobileToken = randomBytes(24).toString('base64url');
  const ips = getNetworkIps();

  const tokenBuf = Buffer.from(token);
  const subtaskTokenBuf = Buffer.from(subtaskToken);
  const mobileTokenBuf = Buffer.from(mobileToken);

  // Tokens minted by successful device pairing. In-memory only: they die with
  // the server, consistent with the mobile/coordinator tokens above. One entry
  // per paired phone.
  const pairedTokenBufs: Buffer[] = [];
  // At most one pending PIN at a time — a fresh mint replaces any prior one.
  let pairing: { pinBuf: Buffer; expiresAt: number; attemptsLeft: number } | null = null;

  function isPairedToken(buf: Buffer): boolean {
    // Timing-safe membership check; length guard avoids timingSafeEqual throwing.
    return pairedTokenBufs.some((t) => t.length === buf.length && timingSafeEqual(buf, t));
  }

  function classifyCandidate(candidate: string | null | undefined): TokenClass | null {
    if (!candidate) return null;
    const buf = Buffer.from(candidate);
    if (buf.length === tokenBuf.length && timingSafeEqual(buf, tokenBuf)) return 'coordinator';
    if (buf.length === subtaskTokenBuf.length && timingSafeEqual(buf, subtaskTokenBuf))
      return 'subtask';
    if (buf.length === mobileTokenBuf.length && timingSafeEqual(buf, mobileTokenBuf))
      return 'mobile';
    if (isPairedToken(buf)) return 'paired';
    return null;
  }

  function extractRawToken(req: IncomingMessage): string | null {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    return url.searchParams.get('token');
  }

  function classifyToken(req: IncomingMessage): TokenClass | null {
    return classifyCandidate(extractRawToken(req));
  }

  function generatePairingPin(): { pin: string; expiresAt: number } {
    // 6-digit zero-padded PIN; single active PIN, short TTL, capped attempts.
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = Date.now() + PAIRING_PIN_TTL_MS;
    pairing = { pinBuf: Buffer.from(pin), expiresAt, attemptsLeft: PAIRING_MAX_ATTEMPTS };
    return { pin, expiresAt };
  }

  /** Verify a submitted PIN; on success mints and returns a paired token. */
  function verifyPairingPin(submitted: string): { ok: true; token: string } | { ok: false } {
    if (!pairing || Date.now() > pairing.expiresAt) {
      pairing = null;
      return { ok: false };
    }
    if (pairing.attemptsLeft <= 0) return { ok: false };
    const submittedBuf = Buffer.from(submitted);
    const match =
      submittedBuf.length === pairing.pinBuf.length &&
      timingSafeEqual(submittedBuf, pairing.pinBuf);
    if (!match) {
      pairing.attemptsLeft -= 1;
      if (pairing.attemptsLeft <= 0) pairing = null;
      return { ok: false };
    }
    pairing = null; // single-use
    const pairedToken = randomBytes(24).toString('base64url');
    pairedTokenBufs.push(Buffer.from(pairedToken));
    return { ok: true, token: pairedToken };
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

      const jsonEnd = (status: number, body: unknown) => {
        if (res.headersSent) return;
        res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      // --- Device pairing (mobile → paired elevation) ---
      // A phone holding the read-only mobile token submits the PIN shown on the
      // desktop to obtain a "paired" token allowed to create tasks. Proving the
      // user can read the desktop screen is the same trust basis as the QR code.
      if (url.pathname === '/api/pair/verify' && req.method === 'POST') {
        if (tokenClass !== 'mobile' && tokenClass !== 'paired')
          return jsonEnd(403, { error: 'forbidden' });
        readJsonBody(req)
          .then((body) => {
            const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
            if (!/^\d{6}$/.test(pin)) return jsonEnd(400, { error: 'pin must be 6 digits' });
            const outcome = verifyPairingPin(pin);
            if (!outcome.ok) return jsonEnd(401, { error: 'invalid or expired code' });
            jsonEnd(201, { token: outcome.token });
          })
          .catch(() => jsonEnd(400, { error: 'bad request' }));
        return;
      }

      // --- Paired-mobile task creation ---
      // GET projects for the picker + POST a new top-level task. Both require the
      // elevated "paired" token; the read-only mobile token is rejected here.
      if (url.pathname === '/api/mobile/projects' || url.pathname === '/api/mobile/tasks') {
        if (tokenClass !== 'paired') return jsonEnd(403, { error: 'forbidden' });

        if (url.pathname === '/api/mobile/projects' && req.method === 'GET') {
          if (!opts.getProjects) return jsonEnd(503, { error: 'task creation unavailable' });
          opts
            .getProjects()
            .then((projects) => jsonEnd(200, projects))
            .catch((err) => jsonEnd(500, { error: String(err) }));
          return;
        }

        if (url.pathname === '/api/mobile/tasks' && req.method === 'POST') {
          const createTask = opts.createTaskFromMobile;
          if (!createTask) return jsonEnd(503, { error: 'task creation unavailable' });
          readJsonBody(req)
            .then((body) => {
              const rawName = typeof body.name === 'string' ? body.name : '';
              // Strip control chars so a task name can't inject terminal/log escapes.
              // eslint-disable-next-line no-control-regex
              const name = rawName.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
              if (!name) return jsonEnd(400, { error: 'name must be a non-empty string' });
              if (name.length > 200)
                return jsonEnd(400, { error: 'name must be 200 characters or fewer' });
              const prompt = validateRestPrompt(body.prompt, true);
              if (typeof prompt !== 'string') return jsonEnd(400, prompt);
              const projectId = typeof body.projectId === 'string' ? body.projectId : '';
              if (!projectId)
                return jsonEnd(400, { error: 'projectId must be a non-empty string' });
              createTask({ projectId, name, prompt })
                .then((r) => jsonEnd(201, { taskId: r.taskId }))
                .catch((err) => jsonEnd(500, { error: String(err) }));
            })
            .catch(() => jsonEnd(400, { error: 'bad request' }));
          return;
        }

        return jsonEnd(405, { error: 'method not allowed' });
      }

      // --- Task notes (mobile + paired) ---
      // Read/write the notes textarea shown on the desktop task panel. Available
      // to the read-only mobile token too: editing notes is low-risk and mirrors
      // the "interact with your terminals" capability the mobile token already has.
      const notesMatch = url.pathname.match(/^\/api\/mobile\/notes\/([^/]+)$/);
      if (notesMatch) {
        if (tokenClass !== 'mobile' && tokenClass !== 'paired')
          return jsonEnd(403, { error: 'forbidden' });
        // decodeURIComponent throws URIError on a malformed escape (e.g. "%").
        // This handler has no outer try/catch, so an unguarded throw here would
        // take down the main process — reject with 400 instead.
        let taskId: string;
        try {
          taskId = decodeURIComponent(notesMatch[1]);
        } catch {
          return jsonEnd(400, { error: 'invalid task id' });
        }

        if (req.method === 'GET') {
          if (!opts.getTaskNotes) return jsonEnd(503, { error: 'notes unavailable' });
          opts
            .getTaskNotes(taskId)
            .then((notes) => jsonEnd(200, { notes }))
            .catch((err) => jsonEnd(500, { error: String(err) }));
          return;
        }

        if (req.method === 'PUT') {
          const setTaskNotes = opts.setTaskNotes;
          if (!setTaskNotes) return jsonEnd(503, { error: 'notes unavailable' });
          // Cap the body above MAX_NOTES_BYTES so the byte check below is the
          // effective limit (readJsonBody's 64 KB default would otherwise reject
          // valid large notes first with a generic "Body too large").
          readJsonBody(req, MAX_NOTES_BYTES + 4096)
            .then((body) => {
              if (typeof body.notes !== 'string')
                return jsonEnd(400, { error: 'notes must be a string' });
              if (Buffer.byteLength(body.notes, 'utf8') > MAX_NOTES_BYTES)
                return jsonEnd(400, { error: `notes must be ${MAX_NOTES_BYTES} bytes or fewer` });
              setTaskNotes(taskId, body.notes)
                .then(() => jsonEnd(200, { ok: true }))
                .catch((err) => jsonEnd(500, { error: String(err) }));
            })
            .catch(() => jsonEnd(400, { error: 'bad request' }));
          return;
        }

        return jsonEnd(405, { error: 'method not allowed' });
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
      // Mobile / paired tokens: the REST surface here is read-only agent status.
      // (NOTE: these tokens are NOT read-only overall — the WebSocket lets them
      // type into agent PTYs; that is the intended "interact with your terminals"
      // feature. Pairing gates the *additional* ability to create new tasks,
      // handled above.) Paired tokens get the same read routes here. Coordinator
      // routes stay excluded; all of these tokens are reachable by anyone on the
      // local network.
      if (tokenClass === 'mobile' || tokenClass === 'paired') {
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
        const list = buildAgentList(opts.getTaskName, opts.getAgentStatus, getTaskAttention);
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
        const jsonReply = createJsonReply(res, SECURITY_HEADERS);
        const readBody = () => readCoordinatorBody(req, jsonReply);

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

        const requireTask = (taskId: string) =>
          requireOwnedTask(orch, taskId, callerCoordinatorId, jsonReply);

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

        const routeCtx: CoordinatorRouteContext = {
          orch,
          tokenClass,
          callerCoordinatorId,
          jsonReply,
          readBody,
          requireTask,
          hasMatchingDoneToken,
        };

        const rootRoute = COORDINATOR_ROOT_ROUTES.find(
          (route) => route.pathname === url.pathname && route.method === req.method,
        );
        if (rootRoute) {
          rootRoute.handler(routeCtx);
          return;
        }

        if (taskIdMatch) {
          const taskId = decodeURIComponent(taskIdMatch[1]);
          const subpath = taskIdMatch[2] ?? null;
          const taskRoute = COORDINATOR_TASK_ROUTES.find(
            (route) => route.subpath === subpath && route.method === req.method,
          );
          if (taskRoute) {
            taskRoute.handler(routeCtx, taskId);
            return;
          }
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
    const list = buildAgentList(opts.getTaskName, opts.getAgentStatus, getTaskAttention);
    broadcast({ type: 'agents', list });
  });

  const unsubListChanged = onPtyEvent('list-changed', () => {
    const list = buildAgentList(opts.getTaskName, opts.getAgentStatus, getTaskAttention);
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
      const list = buildAgentList(opts.getTaskName, opts.getAgentStatus, getTaskAttention);
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
      const list = buildAgentList(opts.getTaskName, opts.getAgentStatus, getTaskAttention);
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
          const list = buildAgentList(opts.getTaskName, opts.getAgentStatus, getTaskAttention);
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
    generatePairingPin,
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
    const onError = (err: NodeJS.ErrnoException) => reject(toFriendlyListenError(err, opts.port));
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
