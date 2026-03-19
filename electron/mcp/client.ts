// HTTP client wrapper for calling the remote server API.
// Used by the MCP server to delegate tool calls to the Electron app.

import type { ApiTaskSummary, ApiTaskDetail, ApiDiffResult, ApiMergeResult } from './types.js';

export class MCPClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };

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
    prompt?: string;
    projectId?: string;
  }): Promise<ApiTaskDetail> {
    return this.request<ApiTaskDetail>('POST', '/api/tasks', opts);
  }

  async listTasks(): Promise<ApiTaskSummary[]> {
    return this.request<ApiTaskSummary[]>('GET', '/api/tasks');
  }

  async getTaskStatus(taskId: string): Promise<ApiTaskDetail> {
    return this.request<ApiTaskDetail>('GET', `/api/tasks/${encodeURIComponent(taskId)}`);
  }

  async sendPrompt(taskId: string, prompt: string): Promise<void> {
    await this.request<unknown>('POST', `/api/tasks/${encodeURIComponent(taskId)}/prompt`, {
      prompt,
    });
  }

  async waitForIdle(taskId: string, timeoutMs?: number): Promise<{ status: string }> {
    return this.request<{ status: string }>(
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
    opts?: { squash?: boolean; message?: string; cleanup?: boolean },
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
}
