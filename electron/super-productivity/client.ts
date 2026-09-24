/**
 * HTTP client for Super Productivity's Local REST API
 * (https://github.com/super-productivity/super-productivity — docs/wiki/3.01-API.md).
 *
 * Runs in the main process only: the token must never reach the renderer, and
 * the API rejects any request that carries a browser Origin header. Responses
 * come from another app, so every field is narrowed before it is returned.
 */
import type {
  SpConnectionState,
  SpFailureReason,
  SpProject,
  SpResult,
  SpTaskDetail,
  SpTaskSummary,
  SpTrackingState,
} from '../shared/super-productivity.js';
import { appendSpNote } from '../shared/super-productivity.js';

export const SP_API_BASE_URL = 'http://127.0.0.1:3876';
const DEFAULT_TIMEOUT_MS = 5_000;
/** Enough for every open task in a busy session; bounds a renderer-supplied list. */
export const SP_MAX_BATCH_IDS = 50;
const BATCH_CONCURRENCY = 5;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SpClientDeps {
  getToken: () => string | null;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

type RawResult = SpResult<unknown>;
type SpFailure = Extract<SpResult<never>, { ok: false }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTaskSummary(value: unknown): SpTaskSummary | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string') {
    return null;
  }
  return {
    id: value.id,
    title: value.title,
    isDone: value.isDone === true,
    projectId: typeof value.projectId === 'string' && value.projectId ? value.projectId : null,
    parentId: typeof value.parentId === 'string' && value.parentId ? value.parentId : null,
  };
}

function toTaskDetail(value: unknown): SpTaskDetail | null {
  const summary = toTaskSummary(value);
  if (!summary || !isRecord(value)) return null;
  const issueUrl =
    typeof value.issueUrl === 'string' && /^https?:\/\//i.test(value.issueUrl)
      ? value.issueUrl
      : undefined;
  return {
    ...summary,
    notes: typeof value.notes === 'string' ? value.notes : '',
    ...(issueUrl ? { issueUrl } : {}),
  };
}

function toProject(value: unknown): SpProject | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string') {
    return null;
  }
  if (value.isArchived === true) return null;
  return { id: value.id, title: value.title };
}

function failure(reason: SpFailureReason, message?: string): SpFailure {
  return message ? { ok: false, reason, message } : { ok: false, reason };
}

function reasonForStatus(status: number, code: string | undefined): SpFailureReason {
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 400) return 'invalid_request';
  if (status === 503) return code === 'APP_NOT_READY' ? 'not_ready' : 'disabled';
  return 'error';
}

export function createSpClient(deps: SpClientDeps) {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const baseUrl = deps.baseUrl ?? SP_API_BASE_URL;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(method: string, path: string, body?: unknown): Promise<RawResult> {
    const token = deps.getToken();
    if (!token) return failure('not_configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // Refused connection (app not running) or timeout. The error text can
      // echo the request, so it is not passed on.
      return failure('unreachable');
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return failure(res.ok ? 'error' : reasonForStatus(res.status, undefined));
    }
    if (res.ok && isRecord(parsed) && parsed.ok === true) {
      return { ok: true, value: parsed.data };
    }
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
    const code = typeof error?.code === 'string' ? error.code : undefined;
    const message = typeof error?.message === 'string' ? error.message.slice(0, 300) : undefined;
    return failure(reasonForStatus(res.status, code), message);
  }

  async function getTask(taskId: string): Promise<SpResult<SpTaskDetail>> {
    const res = await request('GET', `/tasks/${encodeURIComponent(taskId)}`);
    if (!res.ok) return res;
    const task = toTaskDetail(res.value);
    return task ? { ok: true, value: task } : failure('error', 'Unexpected task shape');
  }

  return {
    async getConnectionState(): Promise<SpConnectionState> {
      const res = await request('GET', '/status');
      if (res.ok) return 'connected';
      switch (res.reason) {
        case 'not_configured':
        case 'unreachable':
        case 'disabled':
        case 'unauthorized':
        case 'not_ready':
          return res.reason;
        default:
          return 'unreachable';
      }
    },

    async listProjects(): Promise<SpResult<SpProject[]>> {
      const res = await request('GET', '/projects');
      if (!res.ok) return res;
      if (!Array.isArray(res.value)) return failure('error', 'Unexpected project list');
      const projects = res.value.map(toProject).filter((p): p is SpProject => p !== null);
      return { ok: true, value: projects };
    },

    async getTracking(): Promise<SpResult<SpTrackingState>> {
      const [current, focus] = await Promise.all([
        request('GET', '/task-control/current'),
        request('GET', '/focus'),
      ]);
      if (!current.ok) return current;
      const timer =
        focus.ok && isRecord(focus.value) && isRecord(focus.value.timer)
          ? focus.value.timer
          : undefined;
      return {
        ok: true,
        value: {
          current: current.value === null ? null : toTaskSummary(current.value),
          // A paused break is still a break; 'done' means it is over.
          isBreak:
            timer?.purpose === 'break' && (timer.status === 'running' || timer.status === 'paused'),
        },
      };
    },

    async startTracking(taskId: string): Promise<SpResult<null>> {
      const res = await request('POST', '/task-control/current', { taskId });
      return res.ok ? { ok: true, value: null } : res;
    },

    async createTask(input: {
      title: string;
      projectId?: string;
      parentId?: string;
    }): Promise<SpResult<SpTaskSummary>> {
      const body: Record<string, string> = { title: input.title };
      if (input.parentId) body.parentId = input.parentId;
      else if (input.projectId) body.projectId = input.projectId;
      const res = await request('POST', '/tasks', body);
      if (!res.ok) return res;
      const task = toTaskSummary(res.value);
      return task ? { ok: true, value: task } : failure('error', 'Unexpected task shape');
    },

    getTask,

    /** Missing tasks (deleted or archived in Super Productivity) are left out. */
    async getTasks(taskIds: readonly string[]): Promise<SpResult<SpTaskSummary[]>> {
      const found: SpTaskSummary[] = [];
      const queue = [...new Set(taskIds)].slice(0, SP_MAX_BATCH_IDS);
      // A holder, not a `let`: the workers assign it from inside closures.
      const failed: { first: SpFailure | null } = { first: null };
      const worker = async (): Promise<void> => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          const res = await getTask(id);
          if (res.ok) found.push(res.value);
          else if (res.reason !== 'not_found') {
            failed.first ??= res;
            queue.length = 0; // the app is down or the token is wrong: stop asking
          }
        }
      };
      await Promise.all(Array.from({ length: BATCH_CONCURRENCY }, worker));
      if (failed.first && found.length === 0) return failed.first;
      return { ok: true, value: found };
    },

    async renameTask(taskId: string, title: string): Promise<SpResult<null>> {
      const res = await request('PATCH', `/tasks/${encodeURIComponent(taskId)}`, { title });
      return res.ok ? { ok: true, value: null } : res;
    },

    /** Mark done and append one line to the task's notes. */
    async completeTask(taskId: string, note: string): Promise<SpResult<null>> {
      const current = await getTask(taskId);
      if (!current.ok) return current;
      const res = await request('PATCH', `/tasks/${encodeURIComponent(taskId)}`, {
        isDone: true,
        notes: appendSpNote(current.value.notes, note),
      });
      return res.ok ? { ok: true, value: null } : res;
    },
  };
}
