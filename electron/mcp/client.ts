// HTTP client wrapper for calling the remote server API.
// Used by the MCP server to delegate tool calls to the Electron app.

import type { MindMapDocument, MindMapUpdate } from '../shared/mindmap.js';
import type { CanvasRequest } from '../shared/canvas-view.js';
import type { AgentTourPayload } from '../shared/agent-tour.js';
import type { ConfidencePayload } from '../shared/task-confidence.js';
import type { PrDraft } from '../shared/pr-draft.js';
import type { GitHubCustomList } from '../shared/github-list.js';
import type { ReasoningDocument } from '../shared/reasoning.js';
import type { ReasoningUpdate } from '../shared/reasoning-state.js';
import { randomUUID } from 'crypto';
import type { SignalDoneInput, SignalDoneResult } from '../shared/completion-report.js';
import type {
  ApiTaskSummary,
  ApiTaskDetail,
  ApiDiffResult,
  ApiMergeResult,
  ApiLandSelfResult,
  LandSelfInput,
  WaitForSignalDoneResult,
} from './types.js';

/** Keeps a proxy's HTML error page from flooding the agent's context. */
const MAX_ERROR_BODY_CHARS = 2000;
/** Slack beyond the server-side wait so the server's own timed-out reply wins the race. */
const WAIT_CLIENT_MARGIN_MS = 30_000;

/** AbortSignal.any needs Node 20.3; this server runs on whatever `node` the user has. */
function eitherSignal(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a || !b) return a ?? b;
  const controller = new AbortController();
  for (const source of [a, b]) {
    if (source.aborted) controller.abort(source.reason);
    else source.addEventListener('abort', () => controller.abort(source.reason), { once: true });
  }
  return controller.signal;
}

/** Undici reports every network failure as a bare `fetch failed`; name the app and the cause. */
function unreachableError(baseUrl: string, err: TypeError): TypeError {
  // `Error.cause` is ES2022; the Electron build targets ES2020 libs.
  const cause = (err as { cause?: unknown }).cause;
  const code =
    cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
      ? ` (${cause.code})`
      : '';
  // Still a TypeError: waitForSignalDone retries network failures by that type.
  return Object.assign(
    new TypeError(
      `Parallel Code app unreachable at ${new URL(baseUrl).origin}${code}. If the app restarted, restart or resume this agent session.`,
    ),
    { cause: err },
  );
}

function truncateErrorBody(text: string): string {
  return text.length > MAX_ERROR_BODY_CHARS
    ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}... [truncated ${text.length - MAX_ERROR_BODY_CHARS} chars]`
    : text;
}

export class MCPClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private coordinatorId?: string,
    private doneToken?: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { timeoutMs?: number; owner?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
    // Per-task done token is sent as X-Done-Token so the server can verify task ownership
    // without needing per-task bearer token classification.
    if (opts.owner && this.doneToken) headers['X-Done-Token'] = this.doneToken;
    if (this.coordinatorId) {
      headers['X-Coordinator-Id'] = this.coordinatorId;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: eitherSignal(
          opts.timeoutMs !== undefined ? AbortSignal.timeout(opts.timeoutMs) : undefined,
          opts.signal,
        ),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError')
        throw new Error(`API ${method} ${path} timed out after ${opts.timeoutMs}ms`);
      if (err instanceof TypeError && err.message === 'fetch failed')
        throw unreachableError(this.baseUrl, err);
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${method} ${path} failed (${res.status}): ${truncateErrorBody(text)}`);
    }

    // 204 and other empty 2xx bodies carry no JSON; callers that expect one validate it.
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async callSessionTool(
    name: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request<unknown>('POST', '/api/session/tools', { name, params }, { signal });
  }

  async createTask(opts: {
    name: string;
    prompt: string;
    coordinatorTaskId?: string;
    baseBranch?: string;
  }): Promise<ApiTaskDetail> {
    return this.request<ApiTaskDetail>('POST', '/api/tasks', opts);
  }

  async listTasks(): Promise<ApiTaskSummary[]> {
    return this.request<ApiTaskSummary[]>('GET', '/api/tasks');
  }

  async getTaskStatus(taskId: string): Promise<ApiTaskDetail> {
    return this.request<ApiTaskDetail>('GET', `/api/tasks/${encodeURIComponent(taskId)}`);
  }

  async sendPrompt(taskId: string, prompt: string): Promise<{ queued?: boolean }> {
    return this.request<{ queued?: boolean }>(
      'POST',
      `/api/tasks/${encodeURIComponent(taskId)}/prompt`,
      {
        prompt,
      },
    );
  }

  async waitForIdle(
    taskId: string,
    timeoutMs?: number,
  ): Promise<{ status: string; reason: string }> {
    return this.request<{ status: string; reason: string }>(
      'POST',
      `/api/tasks/${encodeURIComponent(taskId)}/wait`,
      { timeoutMs },
      { timeoutMs: timeoutMs !== undefined ? timeoutMs + WAIT_CLIENT_MARGIN_MS : undefined },
    );
  }

  async getTaskDiff(taskId: string): Promise<ApiDiffResult> {
    return this.request<ApiDiffResult>('GET', `/api/tasks/${encodeURIComponent(taskId)}/diff`);
  }

  async getTaskOutput(taskId: string): Promise<{ output: string }> {
    return this.request<{ output: string }>(
      'GET',
      `/api/tasks/${encodeURIComponent(taskId)}/output`,
    );
  }

  async mergeTask(
    taskId: string,
    opts?: { squash?: boolean; message?: string; cleanup?: boolean; skipVerification?: boolean },
  ): Promise<ApiMergeResult> {
    return this.request<ApiMergeResult>(
      'POST',
      `/api/tasks/${encodeURIComponent(taskId)}/merge`,
      opts ?? {},
    );
  }

  async closeTask(taskId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/api/tasks/${encodeURIComponent(taskId)}`);
  }

  async readMindMap(taskId: string): Promise<MindMapDocument> {
    return this.taskOwnerRequest('GET', `/api/mindmaps/${encodeURIComponent(taskId)}`);
  }
  async readReasoning(taskId: string): Promise<ReasoningDocument> {
    return this.taskOwnerRequest('GET', `/api/reasoning/${encodeURIComponent(taskId)}`);
  }
  async updateReasoning(taskId: string, update: ReasoningUpdate): Promise<ReasoningDocument> {
    return this.taskOwnerRequest('POST', `/api/reasoning/${encodeURIComponent(taskId)}`, update);
  }

  async updateMindMap(taskId: string, update: MindMapUpdate): Promise<MindMapDocument> {
    return this.taskOwnerRequest('POST', `/api/mindmaps/${encodeURIComponent(taskId)}`, update);
  }

  async openCanvas(taskId: string, request: CanvasRequest): Promise<{ ok: true } & CanvasRequest> {
    return this.taskOwnerRequest('POST', `/api/canvas/${encodeURIComponent(taskId)}`, request);
  }

  async publishTour(
    taskId: string,
    payload: AgentTourPayload,
  ): Promise<{ ok: true; subject: string }> {
    return this.taskOwnerRequest('POST', `/api/tours/${encodeURIComponent(taskId)}`, payload);
  }

  async publishConfidence(
    taskId: string,
    payload: ConfidencePayload,
  ): Promise<{ ok: true; scores: number }> {
    return this.taskOwnerRequest('POST', `/api/confidence/${encodeURIComponent(taskId)}`, payload);
  }

  async publishPrDraft(taskId: string, draft: PrDraft): Promise<{ ok: true; title: string }> {
    return this.taskOwnerRequest('POST', `/api/pr-drafts/${encodeURIComponent(taskId)}`, draft);
  }

  async publishGitHubList(
    taskId: string,
    list: GitHubCustomList,
  ): Promise<{ ok: true; name: string }> {
    return this.taskOwnerRequest('POST', `/api/github-lists/${encodeURIComponent(taskId)}`, list);
  }

  async signalDone(taskId: string, input: SignalDoneInput): Promise<SignalDoneResult> {
    return this.taskOwnerRequest('POST', `/api/tasks/${encodeURIComponent(taskId)}/done`, input);
  }

  async landSelf(taskId: string, input: LandSelfInput): Promise<ApiLandSelfResult> {
    return this.taskOwnerRequest<ApiLandSelfResult>(
      'POST',
      `/api/tasks/${encodeURIComponent(taskId)}/land`,
      input,
    );
  }

  private async taskOwnerRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, path, body, { owner: true });
  }

  /** `signal` is the MCP tool call's cancellation; aborting it closes the long-poll so the
   *  app releases the waiter instead of handing it the next completion. */
  async waitForSignalDone(
    coordinatorTaskId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<WaitForSignalDoneResult> {
    const MAX_RETRIES = 10;
    const startedAt = Date.now();
    // Stable per-call ID so retries after a transport failure replay the cached result
    // rather than blocking on a signal that was already consumed.
    const requestId = randomUUID();
    let lastNetworkError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const elapsed = Date.now() - startedAt;
        const remaining = timeoutMs !== undefined ? timeoutMs - elapsed : undefined;
        if (remaining !== undefined && remaining <= 0) break;
        return await this.request<WaitForSignalDoneResult>(
          'POST',
          '/api/wait-signal',
          { coordinatorTaskId, timeoutMs: remaining, requestId },
          {
            timeoutMs: remaining !== undefined ? remaining + WAIT_CLIENT_MARGIN_MS : undefined,
            signal,
          },
        );
      } catch (err: unknown) {
        // Retry on network-level errors (fetch failed, ECONNRESET, etc.).
        // HTTP errors (4xx/5xx) are application errors and should not be retried.
        const isNetworkError = err instanceof TypeError;
        if (!isNetworkError || attempt === MAX_RETRIES) throw err;
        lastNetworkError = err;
        const elapsedAfterFail = Date.now() - startedAt;
        const remainingAfterFail =
          timeoutMs !== undefined ? timeoutMs - elapsedAfterFail : undefined;
        const delayMs = Math.min(1_000 * 2 ** attempt, 30_000, remainingAfterFail ?? Infinity);
        await new Promise((r) => setTimeout(r, delayMs));
        signal?.throwIfAborted();
      }
    }
    // Only reachable after a network failure ate the budget; the true `remaining` count is
    // unknown, so a synthetic timed-out result would misreport it.
    const cause = lastNetworkError instanceof Error ? `: ${lastNetworkError.message}` : '';
    throw new Error(
      `wait_for_signal_done: no response from the app before the ${timeoutMs}ms timeout elapsed${cause}`,
    );
  }
}
