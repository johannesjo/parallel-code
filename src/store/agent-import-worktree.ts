// An agent's import_worktree call, run here because only the renderer knows
// which worktrees are already tasks. Mirrors the Import Worktrees dialog with
// the creator's project and agent and the dialog's default session choice.

import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store } from './core';
import { getProjectPath } from './projects';
import { listWorktreeSessions } from './sessions';
import { createImportedTask } from './tasks';
import type { ImportableWorktree } from '../ipc/types';
import type { ImportWorktreeRequest } from '../../electron/shared/delegation-types';

/** Most paths an error lists, so a project with many worktrees stays readable. */
const MAX_LISTED_PATHS = 20;

/** Brings a worktree of the creator's project back as a background task. */
export async function importWorktreeForAgent(
  req: ImportWorktreeRequest,
): Promise<{ taskId: string; resumedSessionId: string | null }> {
  // hasOwn, not truthiness: the store proxy resolves inherited keys to objects.
  const creator = Object.hasOwn(store.tasks, req.creatorTaskId)
    ? store.tasks[req.creatorTaskId]
    : undefined;
  if (!creator) throw new Error('Importing task not found');
  // The imported agent would run on the host, outside the creator's container.
  if (creator.dockerMode) throw new Error('A task in a Docker sandbox cannot import worktrees');
  const projectRoot = getProjectPath(creator.projectId);
  if (!projectRoot) throw new Error('Project not found');
  const agentDef = creator.agentIds[0] ? store.agents[creator.agentIds[0]]?.def : undefined;
  if (!agentDef) throw new Error('Importing agent not found');

  const worktree = await findImportable(projectRoot, req.path);
  // Deleting a worktree the user made by hand cannot be undone; only they may opt into that.
  if (req.cleanupOnClose && !worktree.app_created)
    throw new Error(
      'cleanupOnClose is only allowed for worktrees Parallel Code created; import without it',
    );
  const sessionId = await chooseSession(worktree.path, agentDef.command, req.sessionId);
  const taskId = await createImportedTask({
    projectId: creator.projectId,
    worktree,
    agentDef,
    resumeSessionId: sessionId,
    cleanupOnClose: req.cleanupOnClose,
    // The user did not ask for this task directly, so it must not take focus.
    activate: false,
  });
  return { taskId, resumedSessionId: sessionId ?? null };
}

/** The candidate list is the project scope: anything else — another project's
 *  worktree, the main checkout, a plain folder — is not on it. */
async function findImportable(projectRoot: string, path: string): Promise<ImportableWorktree> {
  const candidates = await invoke<ImportableWorktree[]>(IPC.ListImportableWorktrees, {
    projectRoot,
  });
  const untracked = candidates.filter(
    (c) => !Object.values(store.tasks).some((t) => t?.worktreePath === c.path),
  );
  const wanted = path.replace(/[\\/]+$/, '');
  const match = untracked.find((c) => c.path === wanted);
  if (match) return match;
  const listed = untracked.slice(0, MAX_LISTED_PATHS).map((c) => c.path);
  throw new Error(
    listed.length > 0
      ? `Not an importable worktree of this project: ${path}. Importable: ${listed.join(', ')}`
      : `Not an importable worktree of this project: ${path}. This project has none.`,
  );
}

async function chooseSession(
  worktreePath: string,
  command: string,
  requested: string | undefined,
): Promise<string | undefined> {
  const sessions = await listWorktreeSessions(worktreePath, command);
  if (!requested) return sessions[0]?.id;
  if (!sessions.some((s) => s.id === requested))
    throw new Error(`Session ${requested} was not recorded in ${worktreePath} by this agent`);
  return requested;
}
