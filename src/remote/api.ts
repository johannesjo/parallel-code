// REST helpers for the mobile SPA. Data flows over the WebSocket (see ws.ts);
// these cover the request/response actions: pairing and task creation.

import { getToken, getPairedToken } from './auth';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
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
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(msg, res.status);
  }
  return res.json() as Promise<T>;
}

/** Submit the desktop PIN; returns the elevated paired token on success. */
export async function verifyPairingPin(pin: string): Promise<string> {
  const token = getToken();
  if (!token) throw new ApiError('Not connected', 401);
  const r = await request<{ token: string }>('/api/pair/verify', {
    method: 'POST',
    body: { pin },
    token,
  });
  return r.token;
}

export interface MobileProject {
  id: string;
  name: string;
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

/** Save the notes for a task. Works with the base connection token. */
export async function saveNotes(taskId: string, notes: string): Promise<void> {
  const token = getToken();
  if (!token) throw new ApiError('Not connected', 401);
  await request<{ ok: boolean }>(`/api/mobile/notes/${encodeURIComponent(taskId)}`, {
    method: 'PUT',
    body: { notes },
    token,
  });
}
