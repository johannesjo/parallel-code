// MCP configuration files the coordinator writes for its children, and the
// parallel-code entry it adds to a coordinator's own .mcp.json.

import { randomBytes } from 'crypto';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import {
  buildSubTaskMcpConfig,
  getSubTaskMcpConfigPath,
  isAllowedSubTaskMcpConfigPath,
  writeSubTaskMcpConfigSync,
  type SubTaskMcpConfig,
} from '../config.js';
import {
  buildMcpLaunchArgs,
  isAntigravityCommand,
  isCodexCommand,
  type ParallelCodeMcpConfig,
} from '../agent-args.js';
import { writeAntigravityMcpConfig } from '../antigravity-config.js';
import { atomicWriteFileSync } from '../atomic.js';
import { warn as logWarn } from '../../log.js';
import type { SessionCapabilities } from '../../shared/delegation-types.js';
import type { CoordinatedTask, CoordinatorState } from '../types.js';

export type SessionMcpProvider = (
  task: CoordinatedTask,
) => { token: string; sessionCapabilities: SessionCapabilities } | undefined;

export function buildTaskMcpLaunchArgs(
  command: string,
  configPath: string | undefined,
  config: ParallelCodeMcpConfig,
): string[] {
  const server = config.mcpServers['parallel-code'];
  if (isCodexCommand(command) && server.args.includes('--session-profile')) {
    if (!configPath) throw new Error('A private MCP credential file is required for this child.');
    return buildMcpLaunchArgs(command, configPath, {
      mcpServers: {
        'parallel-code': {
          ...server,
          args: [...server.args, '--token-file', configPath],
          env: {},
        },
      },
    });
  }
  return buildMcpLaunchArgs(command, configPath, config);
}

/** Rewrite the MCP config of every child of `coordinatorTaskId` with the server's new credentials. */
export function refreshChildMcpConfigs(
  tasks: Iterable<CoordinatedTask>,
  coordinatorTaskId: string,
  serverInfo: { serverUrl: string; subtaskToken: string; serverPath: string },
  dockerContainerName: string | null,
  sessionMcpProvider: SessionMcpProvider | undefined,
): void {
  const { serverUrl, subtaskToken, serverPath } = serverInfo;
  for (const task of tasks) {
    if (task.coordinatorTaskId !== coordinatorTaskId) continue;
    const mcpConfigPath = task.mcpConfigPath;
    const safeMcpConfigPath = isAllowedSubTaskMcpConfigPath(mcpConfigPath, {
      taskId: task.id,
      serverPath,
      dockerContainerName,
    });
    if (!safeMcpConfigPath) task.mcpConfigPath = undefined;
    // An agy child may have only its worktree file, which needs the new token too.
    if (!safeMcpConfigPath && !task.antigravityWorkspaceMcp) continue;
    // Preserve existing doneToken; generate a fresh one if not yet set (e.g. older persisted task).
    if (!task.doneToken) task.doneToken = randomBytes(24).toString('base64url');
    const { mcpConfig } = buildTaskMcpConfig(
      task,
      { serverPath, serverUrl, subtaskToken, doneToken: task.doneToken },
      sessionMcpProvider,
    );
    if (safeMcpConfigPath && mcpConfigPath) writeSubTaskMcpConfigSync(mcpConfigPath, mcpConfig);
    if (!task.antigravityWorkspaceMcp || !existsSync(task.worktreePath)) continue;
    try {
      writeAntigravityMcpConfig(task.worktreePath, mcpConfig);
    } catch (err) {
      // One child's broken worktree must not leave the others on a stale token.
      logWarn('coordinator.antigravity_mcp', 'could not refresh Antigravity MCP config', {
        taskId: task.id,
        err: String(err),
      });
    }
  }
}

/**
 * Builds the MCP config a sub-task's agent starts with. A session of the
 * task's own replaces the coordinator's shared sub-task token.
 */
export function buildTaskMcpConfig(
  task: CoordinatedTask,
  server: { serverPath: string; serverUrl: string; subtaskToken: string; doneToken: string },
  sessionMcpProvider: SessionMcpProvider | undefined,
): { mcpConfig: SubTaskMcpConfig; session: ReturnType<SessionMcpProvider> } {
  const session = sessionMcpProvider?.(task);
  const mcpConfig = buildSubTaskMcpConfig({
    serverPath: server.serverPath,
    serverUrl: server.serverUrl,
    subtaskToken: session?.token ?? server.subtaskToken,
    sessionCapabilities: session?.sessionCapabilities,
    taskId: task.id,
    doneToken: server.doneToken,
  });
  return { mcpConfig, session };
}

/** Write a restored or relaunched child's MCP config; returns its MCP launch args. */
export function rewriteSubtaskMcpConfig(
  task: CoordinatedTask,
  parent: CoordinatorState | undefined,
  sessionMcpProvider: SessionMcpProvider | undefined,
  mcpConfigPath: string | undefined,
  agentCommand: string | undefined,
): string[] | undefined {
  // Set before the early return: a server that starts later must still refresh the file.
  if (agentCommand) task.antigravityWorkspaceMcp = isAntigravityCommand(agentCommand);
  const serverInfo = parent?.mcpServerInfo;
  if (!serverInfo) return undefined;
  const { serverUrl, subtaskToken, serverPath } = serverInfo;
  if (!task.doneToken) task.doneToken = randomBytes(24).toString('base64url');
  const { mcpConfig, session } = buildTaskMcpConfig(
    task,
    { serverPath, serverUrl, subtaskToken, doneToken: task.doneToken },
    sessionMcpProvider,
  );
  if (session && !mcpConfigPath) {
    mcpConfigPath = getSubTaskMcpConfigPath(parent?.dockerContainerName, serverPath, task.id);
    task.mcpConfigPath = mcpConfigPath;
  }
  if (mcpConfigPath) {
    writeSubTaskMcpConfigSync(mcpConfigPath, mcpConfig);
  }
  // A restored child whose worktree is gone has no session to configure.
  if (task.antigravityWorkspaceMcp && existsSync(task.worktreePath)) {
    try {
      writeAntigravityMcpConfig(task.worktreePath, mcpConfig);
    } catch (err) {
      // Losing the restored task would be worse than one session without coordinator tools.
      logWarn('coordinator.antigravity_mcp', 'could not write Antigravity MCP config', {
        taskId: task.id,
        err: String(err),
      });
    }
  }
  return buildTaskMcpLaunchArgs(agentCommand ?? 'claude', mcpConfigPath, mcpConfig);
}

/** Best-effort removal of a task's per-sub-task MCP config file. */
export function unlinkMcpConfigFile(path: string | undefined): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/**
 * Clean up a coordinator's .mcp.json: restore or remove only the parallel-code key.
 * Always reads current contents (the user may have added keys while running).
 * If there was a pre-existing parallel-code entry, restore it; otherwise delete the key.
 */
export function restoreCoordinatorMcpJson(coordinator: CoordinatorState): void {
  if (!coordinator.mcpJsonPath) return;
  try {
    const raw = existsSync(coordinator.mcpJsonPath)
      ? readFileSync(coordinator.mcpJsonPath, 'utf-8')
      : null;
    if (raw !== null) {
      const content = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      if (content.mcpServers) {
        const current = content.mcpServers['parallel-code'];
        const weWrote = coordinator.writtenMcpParallelCode;
        // Only restore/delete if the current value still matches what we wrote,
        // or if we don't have a record of what we wrote (legacy path — always restore).
        const safeToRestore =
          weWrote === undefined || JSON.stringify(current) === JSON.stringify(weWrote);
        if (safeToRestore) {
          if (coordinator.previousMcpParallelCode !== undefined) {
            content.mcpServers['parallel-code'] = coordinator.previousMcpParallelCode;
          } else {
            delete content.mcpServers['parallel-code'];
          }
        }
      }
      const hasServers = Object.keys(content.mcpServers ?? {}).length > 0;
      const hasOtherKeys = Object.keys(content).filter((k) => k !== 'mcpServers').length > 0;
      if (!hasServers && !hasOtherKeys) {
        unlinkSync(coordinator.mcpJsonPath);
      } else {
        if (!hasServers) delete content.mcpServers;
        atomicWriteFileSync(coordinator.mcpJsonPath, JSON.stringify(content, null, 2));
      }
    }
  } catch {
    /* ignore — file may already be gone or malformed */
  }
}
