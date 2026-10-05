// Handles task-creation requests from paired phones. The remote HTTP server
// (main process) forwards them here so we can run the renderer's normal
// createTask orchestration — the same path the desktop "New Task" dialog uses —
// and reply with the resulting task id. See electron/ipc/register.ts for the
// main-side bridge.

import { publishAgentTour } from './agent-tour';
import { getTaskMindMap, openCanvasViewFromAgent, updateTaskMindMapFromAgent } from './canvas';
import { getTaskReasoning, updateTaskReasoningFromAgent } from './reasoning';
import { unwrap } from 'solid-js/store';
import { store } from './core';
import { codeProjects, getProjectPath } from './projects';
import {
  closeTask,
  createTask,
  getCoordinatorCloseWarning,
  mergeTask,
  updateTaskNotes,
} from './tasks';
import { getVerifyCommand } from './verification';
import { getPrChecks } from './pr-checks-state';
import { refreshTaskStatus } from './taskStatus';
import { isLandedTaskState } from './landing';
import { buildMergeReadiness } from '../components/merge-readiness';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import { getTaskDiffBaseBranch, loadTaskDiff } from '../lib/load-task-diff';
import { loadCommitFiles } from '../lib/commit-status';
import { IPC } from '../../electron/ipc/channels';
import { resolveSkipPermissionsArgs } from '../../electron/shared/skip-permissions';
import type { AgentDef, GitIgnoredEntry, MergeStatus, WorktreeStatus } from '../ipc/types';
import type { Task } from './types';
import type {
  RemoteCloseResult,
  RemoteCommitAction,
  RemoteCommitStatus,
  RemoteTaskDiff,
} from '../../electron/remote/protocol';

interface RendererRequest {
  reqId: string;
}

interface CreateTaskRequest extends RendererRequest {
  projectId: string;
  name: string;
  prompt: string;
}

interface GetNotesRequest extends RendererRequest {
  taskId: string;
}

interface SetNotesRequest extends RendererRequest {
  taskId: string;
  notes: string;
}

interface CloseTaskRequest extends RendererRequest {
  taskId: string;
  force: boolean;
}
interface GetTaskDiffRequest extends RendererRequest {
  taskId: string;
}

function reply(reqId: string, ok: boolean, data?: unknown, error?: string): void {
  // Fire-and-forget: main resolves/rejects the pending HTTP response by reqId.
  invoke(IPC.Remote_RendererReply, { reqId, ok, data, error }).catch(() => {});
}

function handleGetProjects(req: RendererRequest): void {
  reply(
    req.reqId,
    true,
    codeProjects().map((p) => ({
      id: p.id,
      name: p.name,
      agentName:
        (store.availableAgents.find((a) => a.id === store.lastAgentId) ?? store.availableAgents[0])
          ?.name ?? '',
    })),
  );
}

/**
 * Whether a task created from a paired phone should launch with the agent's
 * skip-permissions flag.
 *
 * Mirrors the New Task dialog, which pre-ticks its checkbox from
 * `defaultSkipPermissions` and only offers it for an agent that takes such a
 * flag. Resolved by command too, so an agent restored from an older profile is
 * treated the same as a freshly probed one.
 */
export function remoteSkipPermissions(
  defaultSkipPermissions: boolean,
  agentDef: Pick<AgentDef, 'command'> & Partial<Pick<AgentDef, 'skip_permissions_args'>>,
): boolean {
  return defaultSkipPermissions && resolveSkipPermissionsArgs(agentDef).length > 0;
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
      // Without this the flag was simply never passed, so every task created
      // from a phone launched bare regardless of the setting.
      skipPermissions: remoteSkipPermissions(store.defaultSkipPermissions, agentDef),
      // Someone at the desktop may be mid-task; only they decide what gets focus.
      activate: false,
    });
    reply(req.reqId, true, { taskId });
  } catch (err) {
    reply(req.reqId, false, undefined, errMessage(err));
  }
}

/**
 * True only when `taskId` is a real, own entry of the tasks record.
 *
 * Uses Object.hasOwn, NOT truthiness: `taskId` arrives from a mobile HTTP
 * request, and Solid's store proxy resolves inherited keys (`__proto__`,
 * `constructor`, `toString`, …) to prototype objects, which are truthy but are
 * not tasks. A truthiness guard would let updateTaskNotes → setStore('tasks',
 * '__proto__', 'notes', …) pollute Object.prototype. hasOwn reports only own
 * properties, so it rejects every inherited/dangerous/missing key.
 */
export function isKnownTask(tasks: Record<string, unknown>, taskId: string): boolean {
  return Object.hasOwn(tasks, taskId);
}

function handleGetNotes(req: GetNotesRequest): void {
  if (!isKnownTask(store.tasks, req.taskId)) {
    reply(req.reqId, false, undefined, 'Task not found');
    return;
  }
  reply(req.reqId, true, { notes: store.tasks[req.taskId].notes ?? '' });
}

/** What closing would lose, worded like the desktop Close Task dialog. */
async function closeTaskWarnings(task: Task): Promise<string[]> {
  const warnings: string[] = [];
  const coordinatorWarning = getCoordinatorCloseWarning(task.id);
  if (coordinatorWarning) warnings.push(coordinatorWarning);
  if (task.gitIsolation === 'worktree' && !task.externalWorktree) {
    const status = await invoke<WorktreeStatus>(IPC.GetWorktreeStatus, {
      worktreePath: task.worktreePath,
    });
    if (status.has_uncommitted_changes)
      warnings.push('There are uncommitted changes that will be permanently lost.');
    if (status.has_committed_changes)
      warnings.push('This branch has commits that have not been merged into main.');
  }
  return warnings;
}

async function handleCloseTask(req: CloseTaskRequest): Promise<void> {
  try {
    if (!isKnownTask(store.tasks, req.taskId)) throw new Error('Task not found');
    if (!req.force) {
      const warnings = await closeTaskWarnings(store.tasks[req.taskId]);
      if (warnings.length > 0) {
        reply(req.reqId, true, { closed: false, warnings } satisfies RemoteCloseResult);
        return;
      }
    }
    await closeTask(req.taskId);
    // closeTask records backend failures on the task instead of throwing.
    const after = store.tasks[req.taskId];
    if (after?.closingStatus === 'error') throw new Error(after.closingError ?? 'Close failed');
    reply(req.reqId, true, { closed: true } satisfies RemoteCloseResult);
  } catch (err) {
    reply(req.reqId, false, undefined, errMessage(err));
  }
}

/** Past this, a phone gets the start of the diff; the desktop shows all of it. */
const MAX_REMOTE_DIFF_CHARS = 1_000_000;

async function handleGetDiff(req: GetNotesRequest): Promise<void> {
  try {
    if (!isKnownTask(store.tasks, req.taskId)) throw new Error('Task not found');
    const task = store.tasks[req.taskId];
    // A 'none' task edits the project folder in place: it has no branch and no
    // worktree of its own, so there is nothing to diff it against. Without this
    // the phone would fall through to the project folder and either report a
    // git error or, worse, show unrelated work already sitting in the repo.
    if (task.gitIsolation === 'none') {
      reply(req.reqId, true, {
        diff: '',
        truncated: false,
        unsupported: true,
      } satisfies RemoteTaskDiff);
      return;
    }
    const { rawDiff } = await loadTaskDiff({
      worktreePath: task.worktreePath,
      projectRoot: getProjectPath(task.projectId),
      branchName: task.branchName,
      baseBranch: getTaskDiffBaseBranch(task.gitIsolation, task.baseBranch),
    });
    const truncated = rawDiff.length > MAX_REMOTE_DIFF_CHARS;
    reply(req.reqId, true, {
      diff: truncated ? rawDiff.slice(0, MAX_REMOTE_DIFF_CHARS) : rawDiff,
      truncated,
    } satisfies RemoteTaskDiff);
  } catch (err) {
    reply(req.reqId, false, undefined, errMessage(err));
  }
}

function handleSetNotes(req: SetNotesRequest): void {
  if (!isKnownTask(store.tasks, req.taskId)) {
    reply(req.reqId, false, undefined, 'Task not found');
    return;
  }
  updateTaskNotes(req.taskId, req.notes);
  reply(req.reqId, true, { ok: true });
}

interface MergeTaskRequest extends RendererRequest {
  taskId: string;
  squash?: boolean;
  cleanup?: boolean;
}

/**
 * Readiness for the phone's merge dialog.
 *
 * Reuses the desktop's pure `buildMergeReadiness` so both surfaces agree on what
 * counts as blocked versus merely worth a warning — a phone that invented its own
 * rules could disagree with the desktop about the same branch.
 */
async function handleGetMergeReadiness(req: GetTaskDiffRequest): Promise<void> {
  if (!isKnownTask(store.tasks, req.taskId)) {
    reply(req.reqId, false, undefined, 'Task not found');
    return;
  }
  const task = store.tasks[req.taskId];
  try {
    // A 'none' task works in the project folder and has no branch to merge.
    if (task.gitIsolation !== 'worktree') {
      reply(req.reqId, true, {
        readiness: {
          overall: 'blocked',
          checks: [
            {
              label: 'Merge safety',
              status: 'blocked',
              detail: 'Only worktree tasks can be merged.',
            },
          ],
        },
        canMerge: false,
        baseBranch: task.baseBranch ?? '',
        branchName: task.branchName,
      });
      return;
    }
    const [mergeStatus, worktreeStatus] = await Promise.all([
      invoke<MergeStatus>(IPC.CheckMergeStatus, {
        worktreePath: task.worktreePath,
        baseBranch: task.baseBranch,
      }),
      invoke<WorktreeStatus>(IPC.GetWorktreeStatus, {
        worktreePath: task.worktreePath,
        baseBranch: task.baseBranch,
      }),
    ]);
    const readiness = buildMergeReadiness({
      expectedBranch: task.branchName,
      mergeStatus,
      mergeStatusLoading: false,
      worktreeStatus,
      worktreeStatusLoading: false,
      verification: task.verification,
      verificationRun: task.verificationRun,
      verifyCommandConfigured: Boolean(getVerifyCommand(task.id)),
      prChecks: getPrChecks(task.id),
      // Coverage comparison needs a base report the phone has no way to read;
      // the check reports "no task coverage report" instead of guessing.
      coverage: null,
    });
    reply(req.reqId, true, {
      readiness,
      canMerge: readiness.overall !== 'blocked',
      baseBranch: task.baseBranch ?? mergeStatus.base_branch ?? '',
      branchName: task.branchName,
    });
  } catch (err) {
    reply(req.reqId, false, undefined, errMessage(err));
  }
}

/** Merge a task from a paired phone. Runs the desktop's own mergeTask. */
async function handleMergeTask(req: MergeTaskRequest): Promise<void> {
  if (!isKnownTask(store.tasks, req.taskId)) {
    reply(req.reqId, false, undefined, 'Task not found');
    return;
  }
  try {
    await mergeTask(req.taskId, {
      squash: req.squash === true,
      // Cleanup is opt-in and defaults off: a phone tap should not delete a
      // worktree and branch the way the desktop checkbox explicitly allows.
      cleanup: req.cleanup === true,
    });
    reply(req.reqId, true, { ok: true });
  } catch (err) {
    reply(req.reqId, false, undefined, errMessage(err));
  }
}

interface CommitActionRequest extends RendererRequest {
  taskId: string;
  action: RemoteCommitAction;
  message?: string;
}

/**
 * The worktree a phone may commit in, or null when the task has none. Matches
 * the desktop, which only offers its commit dialog on unlanded worktree tasks.
 */
function commitWorktreePath(taskId: string): string | null {
  if (!isKnownTask(store.tasks, taskId)) throw new Error('Task not found');
  const task = store.tasks[taskId];
  if (task.gitIsolation !== 'worktree' || isLandedTaskState(task.landingState)) return null;
  return task.worktreePath;
}

async function commitStatus(worktreePath: string | null): Promise<RemoteCommitStatus> {
  if (!worktreePath) return { files: [], unsupported: true };
  return { files: await loadCommitFiles(worktreePath) };
}

/** The phone's commit dialog: uncommitted files and what is staged. */
async function handleGetCommitStatus(req: GetTaskDiffRequest): Promise<void> {
  try {
    reply(req.reqId, true, await commitStatus(commitWorktreePath(req.taskId)));
  } catch (err) {
    reply(req.reqId, false, undefined, errMessage(err));
  }
}

/** Stage all, unstage all or commit from a paired phone; replies with the new status. */
async function handleCommitAction(req: CommitActionRequest): Promise<void> {
  try {
    const worktreePath = commitWorktreePath(req.taskId);
    if (!worktreePath) throw new Error('Only worktree tasks can be committed from the phone.');
    try {
      if (req.action === 'stage-all') await invoke(IPC.StageAll, { worktreePath });
      else if (req.action === 'unstage-all') await invoke(IPC.UnstageAll, { worktreePath });
      else await invoke(IPC.CommitStaged, { worktreePath, message: req.message ?? '' });
    } finally {
      refreshTaskStatus(req.taskId);
    }
    reply(req.reqId, true, await commitStatus(worktreePath));
  } catch (err) {
    reply(req.reqId, false, undefined, errMessage(err));
  }
}

/** Subscribe to mobile task-creation requests. Returns an unsubscribe fn. */
export function startRemoteTaskHandlers(): () => void {
  const offReadReasoning = window.electron.ipcRenderer.on(
    IPC.MCP_ReadReasoningRequest,
    (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const req = data as GetNotesRequest;
      void getTaskReasoning(req.taskId).then(
        (document) => reply(req.reqId, true, document),
        (error: unknown) => reply(req.reqId, false, undefined, errMessage(error)),
      );
    },
  );
  const offUpdateReasoning = window.electron.ipcRenderer.on(
    IPC.MCP_UpdateReasoningRequest,
    (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const req = data as GetNotesRequest & { update: unknown };
      void updateTaskReasoningFromAgent(req.taskId, req.update).then(
        (document) => reply(req.reqId, true, document),
        (error: unknown) => reply(req.reqId, false, undefined, errMessage(error)),
      );
    },
  );
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
  const offGetNotes = window.electron.ipcRenderer.on(
    IPC.Remote_GetNotesRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') handleGetNotes(data as GetNotesRequest);
    },
  );
  const offGetUsage = window.electron.ipcRenderer.on(
    IPC.Remote_GetUsageRequest,
    (data: unknown) => {
      if (data && typeof data === 'object')
        reply((data as RendererRequest).reqId, true, unwrap(store.usage));
    },
  );
  const offSetNotes = window.electron.ipcRenderer.on(
    IPC.Remote_SetNotesRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') handleSetNotes(data as SetNotesRequest);
    },
  );
  const offDiff = window.electron.ipcRenderer.on(IPC.Remote_GetDiffRequest, (data: unknown) => {
    if (data && typeof data === 'object') void handleGetDiff(data as GetNotesRequest);
  });
  const offReadiness = window.electron.ipcRenderer.on(
    IPC.Remote_GetMergeReadinessRequest,
    (data: unknown) => {
      if (data && typeof data === 'object')
        void handleGetMergeReadiness(data as GetTaskDiffRequest);
    },
  );
  const offMerge = window.electron.ipcRenderer.on(IPC.Remote_MergeTaskRequest, (data: unknown) => {
    if (data && typeof data === 'object') void handleMergeTask(data as MergeTaskRequest);
  });
  const offCommitStatus = window.electron.ipcRenderer.on(
    IPC.Remote_GetCommitStatusRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') void handleGetCommitStatus(data as GetTaskDiffRequest);
    },
  );
  const offCommitAction = window.electron.ipcRenderer.on(
    IPC.Remote_CommitActionRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') void handleCommitAction(data as CommitActionRequest);
    },
  );
  const offClose = window.electron.ipcRenderer.on(IPC.Remote_CloseTaskRequest, (data: unknown) => {
    if (data && typeof data === 'object') void handleCloseTask(data as CloseTaskRequest);
  });
  const offReadMap = window.electron.ipcRenderer.on(IPC.MCP_ReadMindMapRequest, (data: unknown) => {
    if (!data || typeof data !== 'object') return;
    const req = data as GetNotesRequest;
    try {
      reply(req.reqId, true, getTaskMindMap(req.taskId));
    } catch (error) {
      reply(req.reqId, false, undefined, errMessage(error));
    }
  });
  const offUpdateMap = window.electron.ipcRenderer.on(
    IPC.MCP_UpdateMindMapRequest,
    (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const req = data as GetNotesRequest & { update: unknown };
      void updateTaskMindMapFromAgent(req.taskId, req.update).then(
        (map) => reply(req.reqId, true, map),
        (error: unknown) => reply(req.reqId, false, undefined, errMessage(error)),
      );
    },
  );
  const offOpenCanvas = window.electron.ipcRenderer.on(
    IPC.MCP_OpenCanvasRequest,
    (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const req = data as GetNotesRequest & { view: unknown };
      try {
        openCanvasViewFromAgent(req.taskId, req);
        reply(req.reqId, true, { ok: true });
      } catch (error) {
        reply(req.reqId, false, undefined, errMessage(error));
      }
    },
  );
  const offPublishTour = window.electron.ipcRenderer.on(
    IPC.MCP_PublishTourRequest,
    (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const req = data as GetNotesRequest & { payload: unknown };
      try {
        publishAgentTour(req.taskId, req.payload);
        reply(req.reqId, true, { ok: true });
      } catch (error) {
        reply(req.reqId, false, undefined, errMessage(error));
      }
    },
  );
  return () => {
    offReadReasoning();
    offUpdateReasoning();
    offReadMap();
    offUpdateMap();
    offOpenCanvas();
    offPublishTour();
    offProjects();
    offCreate();
    offGetNotes();
    offSetNotes();
    offClose();
    offDiff();
    offReadiness();
    offMerge();
    offCommitStatus();
    offCommitAction();
    offGetUsage();
  };
}
