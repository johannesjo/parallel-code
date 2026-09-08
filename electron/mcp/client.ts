// HTTP client wrapper for calling the remote server API.
// Used by the MCP server to delegate tool calls to the Electron app.

import { randomUUID } from 'crypto';
import type {
  ApiTaskSummary,
  ApiTaskDetail,
  ApiDiffResult,
  ApiMergeResult,
  ApiReviewAndMergeResult,
  ApiLandSelfResult,
  LandSelfInput,
  WaitForSignalDoneResult,
} from './types.js';

export class MCPClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private coordinatorId?: string,
    private doneToken?: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
    if (this.coordinatorId) {
      headers['X-Coordinator-Id'] = this.coordinatorId;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${method} ${path} failed (${res.status}): ${text}`);
    }

    return (await res.json()) as T;
  }

  async createTask(opts: {
    name: string;
    prompt: string;
    projectId?: string;
    coordinatorTaskId?: string;
    skipPermissions?: boolean;
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

  async signalDone(taskId: string): Promise<void> {
    await this.taskOwnerRequest('POST', `/api/tasks/${encodeURIComponent(taskId)}/done`, {});
  }

  async landSelf(taskId: string, input: LandSelfInput): Promise<ApiLandSelfResult> {
    return this.taskOwnerRequest<ApiLandSelfResult>(
      'POST',
      `/api/tasks/${encodeURIComponent(taskId)}/land`,
      input,
    );
  }

  private async taskOwnerRequest<T>(method: string, path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
    // Per-task done token is sent as X-Done-Token so the server can verify task ownership
    // without needing per-task bearer token classification.
    if (this.doneToken) headers['X-Done-Token'] = this.doneToken;
    const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${method} ${path} failed (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  }

  async waitForSignalDone(
    coordinatorTaskId: string,
    timeoutMs?: number,
  ): Promise<WaitForSignalDoneResult> {
    const MAX_RETRIES = 10;
    const startedAt = Date.now();
    // Stable per-call ID so retries after a transport failure replay the cached result
    // rather than blocking on a signal that was already consumed.
    const requestId = randomUUID();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const elapsed = Date.now() - startedAt;
        const remaining = timeoutMs !== undefined ? timeoutMs - elapsed : undefined;
        if (remaining !== undefined && remaining <= 0) break;
        return await this.request<WaitForSignalDoneResult>('POST', '/api/wait-signal', {
          coordinatorTaskId,
          timeoutMs: remaining,
          requestId,
        });
      } catch (err: unknown) {
        // Retry on network-level errors (fetch failed, ECONNRESET, etc.).
        // HTTP errors (4xx/5xx) are application errors and should not be retried.
        const isNetworkError = err instanceof TypeError;
        if (!isNetworkError || attempt === MAX_RETRIES) throw err;
        const elapsedAfterFail = Date.now() - startedAt;
        const remainingAfterFail =
          timeoutMs !== undefined ? timeoutMs - elapsedAfterFail : undefined;
        const delayMs = Math.min(1_000 * 2 ** attempt, 30_000, remainingAfterFail ?? Infinity);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new Error('wait_for_signal_done: timed out retrying after repeated network errors');
  }

  async reviewAndMergeTask(
    taskId: string,
    opts?: { squash?: boolean; message?: string },
  ): Promise<ApiReviewAndMergeResult> {
    return this.request<ApiReviewAndMergeResult>(
      'POST',
      `/api/tasks/${encodeURIComponent(taskId)}/review-merge`,
      opts ?? {},
    );
  }
}
