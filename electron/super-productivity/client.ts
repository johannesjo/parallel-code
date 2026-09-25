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
import { appendSpNote, isValidSpId, SP_MAX_BATCH_IDS } from '../shared/super-productivity.js';

export const SP_API_BASE_URL = 'http://127.0.0.1:3876';
const READ_TIMEOUT_MS = 5_000;
/** Longer than Super Productivity's own 15 s budget: a write that timed out
 *  here could still land there, and a retried create would duplicate it. */
const WRITE_TIMEOUT_MS = 20_000;
const BATCH_CONCURRENCY = 5;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SpClientDeps {
  getToken: () => string | null;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
}

type RawResult = SpResult<unknown>;
type SpFailure = Extract<SpResult<never>, { ok: false }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTaskSummary(value: unknown): SpTaskSummary | null {
  if (!isRecord(value) || !isValidSpId(value.id) || typeof value.title !== 'string') {
    return null;
  }
  return {
    id: value.id,
    title: value.title,
    isDone: value.isDone === true,
    projectId: isValidSpId(value.projectId) ? value.projectId : null,
    parentId: isValidSpId(value.parentId) ? value.parentId : null,
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
  if (!isRecord(value) || !isValidSpId(value.id) || typeof value.title !== 'string') {
    return null;
  }
  if (value.isArchived === true) return null;
  return { id: value.id, title: value.title };
}

function failure(reason: SpFailureReason, message?: string): SpFailure {
  return message ? { ok: false, reason, message } : { ok: false, reason };
}

/** Failures that mean the app can't be talked to at all, as opposed to one request failing. */
const CONNECTION_FAILURES: ReadonlySet<SpFailureReason> = new Set<SpFailureReason>([
  'not_configured',
  'unreachable',
  'disabled',
  'unauthorized',
  'not_ready',
]);

function reasonForStatus(status: number, code: string | undefined): SpFailureReason {
  if (status === 401) return 'unauthorized';
  // Only a missing *entity* (TASK_NOT_FOUND, PARENT_NOT_FOUND, …) counts as
  // gone; an unknown route (NOT_FOUND) or a non-JSON 404 is some other app or
  // version, and must not make callers drop their links.
  if (status === 404) return code?.endsWith('_NOT_FOUND') ? 'not_found' : 'error';
  if (status === 400) return 'invalid_request';
  if (status === 503) return code === 'APP_NOT_READY' ? 'not_ready' : 'disabled';
  return 'error';
}

export function createSpClient(deps: SpClientDeps) {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const baseUrl = deps.baseUrl ?? SP_API_BASE_URL;
  const readTimeoutMs = deps.readTimeoutMs ?? READ_TIMEOUT_MS;
  const writeTimeoutMs = deps.writeTimeoutMs ?? WRITE_TIMEOUT_MS;

  async function request(method: string, path: string, body?: unknown): Promise<RawResult> {
    const token = deps.getToken();
    if (!token) return failure('not_configured');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      method === 'GET' ? readTimeoutMs : writeTimeoutMs,
    );
    let res: Response;
    let parsed: unknown;
    try {
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
      }
      try {
        // Still under the timeout: a body that never finishes must not hang.
        parsed = await res.json();
      } catch {
        if (controller.signal.aborted) return failure('unreachable');
        return failure(res.ok ? 'error' : reasonForStatus(res.status, undefined));
      }
    } finally {
      clearTimeout(timer);
    }
    if (res.ok && isRecord(parsed) && parsed.ok === true) {
      return { ok: true, value: parsed.data };
    }
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
    const code = typeof error?.code === 'string' ? error.code : undefined;
    const message = typeof error?.message === 'string' ? error.message.slice(0, 300) : undefined;
    return failure(reasonForStatus(res.status, code), message);
  }

  /** `includeIssueUrl` is opt-in there: some providers fetch the issue to build it. */
  async function getTask(
    taskId: string,
    opts: { includeIssueUrl?: boolean } = {},
  ): Promise<SpResult<SpTaskDetail>> {
    const query = opts.includeIssueUrl ? '?include=issueUrl' : '';
    const res = await request('GET', `/tasks/${encodeURIComponent(taskId)}${query}`);
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
      const currentTask = current.value === null ? null : toTaskSummary(current.value);
      // Unreadable is not "nothing tracked": that would take tracking over.
      if (current.value !== null && !currentTask) return failure('error', 'Unexpected task shape');
      const timer =
        focus.ok && isRecord(focus.value) && isRecord(focus.value.timer)
          ? focus.value.timer
          : undefined;
      return {
        ok: true,
        value: {
          current: currentTask,
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
      // Literal titles: Super Productivity would otherwise parse `#tag`,
      // `30m`, `@date` and URLs out of them, and the title sync would then
      // copy the shortened title back. Older versions ignore the flag.
      const body: Record<string, string | boolean> = {
        title: input.title,
        isIgnoreShortSyntax: true,
      };
      if (input.parentId) body.parentId = input.parentId;
      else if (input.projectId) body.projectId = input.projectId;
      const res = await request('POST', '/tasks', body);
      if (!res.ok) return res;
      const task = toTaskSummary(res.value);
      return task ? { ok: true, value: task } : failure('error', 'Unexpected task shape');
    },

    getTask,

    /** Missing tasks (deleted or archived in Super Productivity), and ones that
     *  fail to load, are left out; a connection failure ends the batch. */
    async getTasks(taskIds: readonly string[]): Promise<SpResult<SpTaskSummary[]>> {
      const found: SpTaskSummary[] = [];
      const queue = [...new Set(taskIds)].slice(0, SP_MAX_BATCH_IDS);
      // A holder, not a `let`: the workers assign it from inside closures.
      const failed: { first: SpFailure | null } = { first: null };
      const worker = async (): Promise<void> => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          const res = await getTask(id);
          if (res.ok) {
            // Summaries only: notes stay in Super Productivity.
            const { id: taskId, title, isDone, projectId, parentId } = res.value;
            found.push({ id: taskId, title, isDone, projectId, parentId });
          } else if (CONNECTION_FAILURES.has(res.reason)) {
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
      const res = await request('PATCH', `/tasks/${encodeURIComponent(taskId)}`, {
        title,
        isIgnoreShortSyntax: true,
      });
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
