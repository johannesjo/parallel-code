// Handles task-creation requests from paired phones. The remote HTTP server
// (main process) forwards them here so we can run the renderer's normal
// createTask orchestration — the same path the desktop "New Task" dialog uses —
// and reply with the resulting task id. See electron/ipc/register.ts for the
// main-side bridge.

import { store } from './core';
import { createTask } from './tasks';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { GitIgnoredEntry } from '../ipc/types';

interface RendererRequest {
  reqId: string;
}

interface CreateTaskRequest extends RendererRequest {
  projectId: string;
  name: string;
  prompt: string;
}

function reply(reqId: string, ok: boolean, data?: unknown, error?: string): void {
  // Fire-and-forget: main resolves/rejects the pending HTTP response by reqId.
  invoke(IPC.Remote_RendererReply, { reqId, ok, data, error }).catch(() => {});
}

function handleGetProjects(req: RendererRequest): void {
  reply(
    req.reqId,
    true,
    store.projects.map((p) => ({ id: p.id, name: p.name })),
  );
}

async function handleCreateTask(req: CreateTaskRequest): Promise<void> {
  try {
    const project = store.projects.find((p) => p.id === req.projectId);
    if (!project) throw new Error('Project not found');

    // Default agent: the last one used, else the first available (mirrors the
    // New Task dialog's initial selection).
    const agentDef =
      store.availableAgents.find((a) => a.id === store.lastAgentId) ?? store.availableAgents[0];
    if (!agentDef) throw new Error('No agent configured');

    // Non-git projects can't use worktree isolation; fall back to working
    // directly in the project folder.
    const isGit = project.isGitRepo !== false;
    let baseBranch = '';
    let symlinkDirs: string[] = [];
    if (isGit) {
      baseBranch =
        project.defaultBaseBranch ??
        (await invoke<string>(IPC.GetMainBranch, { projectRoot: project.path }));
      // Match the desktop New Task default without opting remote users into
      // newly discovered entries that have no confirmation UI.
      const ignoredEntries = await invoke<GitIgnoredEntry[]>(IPC.GetGitignoredDirs, {
        projectRoot: project.path,
      });
      symlinkDirs = ignoredEntries.filter((entry) => entry.isDefault).map((entry) => entry.name);
    }

    const taskId = await createTask({
      name: req.name,
      agentDef,
      projectId: req.projectId,
      gitIsolation: isGit ? 'worktree' : 'none',
      baseBranch,
      symlinkDirs,
      initialPrompt: req.prompt,
    });
    reply(req.reqId, true, { taskId });
  } catch (err) {
    reply(req.reqId, false, undefined, err instanceof Error ? err.message : String(err));
  }
}

/** Subscribe to mobile task-creation requests. Returns an unsubscribe fn. */
export function startRemoteTaskHandlers(): () => void {
  const offProjects = window.electron.ipcRenderer.on(
    IPC.Remote_GetProjectsRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') handleGetProjects(data as RendererRequest);
    },
  );
  const offCreate = window.electron.ipcRenderer.on(
    IPC.Remote_CreateTaskRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') void handleCreateTask(data as CreateTaskRequest);
    },
  );
  return () => {
    offProjects();
    offCreate();
  };
}
