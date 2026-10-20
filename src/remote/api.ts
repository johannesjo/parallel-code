// REST helpers for the mobile SPA. Data flows over the WebSocket (see ws.ts);
// these cover the request/response actions: pairing, task creation, and
// reading/saving task notes.

import { getToken, getPairedToken } from './auth';

export class ApiError extends Error {
  status: number;
  /** Parsed JSON error body, kept for routes that answer with more than a message. */
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; token: string },
): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let body: unknown;
    try {
      body = await res.json();
      const error = (body as { error?: unknown } | null)?.error;
      if (typeof error === 'string' && error) msg = error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(msg, res.status, body);
  }
  return res.json() as Promise<T>;
}

/** Submit the desktop PIN; returns the elevated paired token on success. */
export async function verifyPairingPin(pin: string, remember: boolean): Promise<string> {
  const token = getToken();
  if (!token) throw new ApiError('Not connected', 401);
  const r = await request<{ token: string }>('/api/pair/verify', {
    method: 'POST',
    body: { pin, remember },
    token,
  });
  return r.token;
}

export interface MobileProject {
  id: string;
  name: string;
  agentName?: string;
}

/** List projects the New Task screen can target. Requires a paired token. */
export function fetchProjects(): Promise<MobileProject[]> {
  const token = getPairedToken();
  if (!token) throw new ApiError('Not paired', 401);
  return request<MobileProject[]>('/api/mobile/projects', { token });
}

/** Create a top-level task. Requires a paired token. Returns the new task id. */
export async function createTask(input: {
  projectId: string;
  name: string;
  prompt: string;
}): Promise<string> {
  const token = getPairedToken();
  if (!token) throw new ApiError('Not paired', 401);
  const r = await request<{ taskId: string }>('/api/mobile/tasks', {
    method: 'POST',
    body: input,
    token,
  });
  return r.taskId;
}

/** Fetch the notes for a task. Works with the base connection token. */
export async function fetchNotes(taskId: string): Promise<string> {
  const token = getToken();
  if (!token) throw new ApiError('Not connected', 401);
  const r = await request<{ notes: string }>(`/api/mobile/notes/${encodeURIComponent(taskId)}`, {
    token,
  });
  return r.notes;
}

export interface TaskDiff {
  diff: string;
  /** True when the diff was cut short for the phone. */
  truncated: boolean;
  /** True when the task has no branch of its own, so there is nothing to review. */
  unsupported?: boolean;
}

/** Fetch a task's diff for review. Works with the base connection token. */
export function fetchTaskDiff(taskId: string): Promise<TaskDiff> {
  const token = getToken();
  if (!token) throw new ApiError('Not connected', 401);
  return request<TaskDiff>(`/api/mobile/tasks/${encodeURIComponent(taskId)}/diff`, { token });
}

export interface ReadinessCheck {
  label: string;
  status: 'pass' | 'warning' | 'blocked' | 'checking' | 'neutral';
  detail: string;
}

export interface MergeReadiness {
  readiness: {
    overall: 'ready' | 'attention' | 'blocked' | 'checking';
    checks: ReadinessCheck[];
  };
  canMerge: boolean;
  baseBranch: string;
  branchName: string;
  /** Whether closing also deletes the branch; absent from older desktops. */
  deleteBranchOnClose?: boolean;
}

/** Fetch read-only merge readiness. Works with the base connection token. */
export function fetchMergeReadiness(taskId: string): Promise<MergeReadiness> {
  const token = getToken();
  if (!token) throw new ApiError('Not connected', 401);
  return request<MergeReadiness>(`/api/mobile/tasks/${encodeURIComponent(taskId)}/readiness`, {
    token,
  });
}

/** Merge a task. Requires a paired token: this runs real git. */
export function mergeTask(
  taskId: string,
  opts: { squash: boolean; cleanup: boolean },
): Promise<void> {
  const token = getPairedToken();
  if (!token) throw new ApiError('Not paired', 401);
  return request<{ ok: boolean }>(`/api/mobile/tasks/${encodeURIComponent(taskId)}/merge`, {
    method: 'POST',
    body: opts,
    token,
  }).then(() => {});
}

/**
 * Close a task. Requires a paired token: this removes its worktree.
 *
 * The desktop refuses when closing would lose work and answers 409 with
 * warnings, so the caller must decide whether to retry with `force`.
 * Returns those warnings; an empty array means the task was closed.
 */
export async function closeTask(taskId: string, force = false): Promise<{ warnings: string[] }> {
  const token = getPairedToken();
  if (!token) throw new ApiError('Not paired', 401);
  try {
    await request<{ ok: boolean }>(`/api/mobile/tasks/${encodeURIComponent(taskId)}/close`, {
      method: 'POST',
      body: { force },
      token,
    });
    return { warnings: [] };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) return { warnings: closeWarnings(err) };
    throw err;
  }
}

/** The desktop's own list of what closing would lose; the message alone names none of it. */
function closeWarnings(err: ApiError): string[] {
  const warnings = (err.body as { warnings?: unknown } | null | undefined)?.warnings;
  const listed = Array.isArray(warnings)
    ? warnings.filter((w): w is string => typeof w === 'string' && w.length > 0)
    : [];
  return listed.length > 0 ? listed : [err.message];
}

/** Save the notes for a task. Requires a paired token (it is a write). */
export async function saveNotes(taskId: string, notes: string): Promise<void> {
  const token = getPairedToken();
  if (!token) throw new ApiError('Not paired', 401);
  await request<{ ok: boolean }>(`/api/mobile/notes/${encodeURIComponent(taskId)}`, {
    method: 'PUT',
    body: { notes },
    token,
  });
}

/** Notification delivery is owned by this paired phone, independently of its live socket. */
export function fetchPushSettings(): Promise<{ publicKey: string; endpoint: string | null }> {
  const token = getPairedToken();
  if (!token) throw new ApiError('Authorize this phone first', 401);
  return request('/api/mobile/push', { token });
}

export function savePushSubscription(subscription: PushSubscriptionJSON): Promise<{ ok: true }> {
  const token = getPairedToken();
  if (!token) throw new ApiError('Authorize this phone first', 401);
  return request('/api/mobile/push', { token, method: 'PUT', body: subscription });
}

export function removePushSubscription(endpoint: string): Promise<{ ok: true }> {
  const token = getPairedToken();
  if (!token) throw new ApiError('Authorize this phone first', 401);
  return request('/api/mobile/push', { token, method: 'DELETE', body: { endpoint } });
}

/** The desktop's Fix CI prompt for the task's PR; null when no check failed. Paired only. */
export async function fetchFixCiPrompt(taskId: string): Promise<string | null> {
  const token = getPairedToken();
  if (!token) throw new ApiError('Not paired', 401);
  const r = await request<{ prompt: string | null }>(
    `/api/mobile/tasks/${encodeURIComponent(taskId)}/fix-ci`,
    { token },
  );
  return r.prompt;
}

/** Send the reviewed Fix CI prompt to the task's agent. Paired only. */
export async function sendFixCiPrompt(taskId: string, prompt: string): Promise<void> {
  const token = getPairedToken();
  if (!token) throw new ApiError('Not paired', 401);
  await request<{ ok: boolean }>(`/api/mobile/tasks/${encodeURIComponent(taskId)}/fix-ci`, {
    method: 'POST',
    body: { prompt },
    token,
  });
}
