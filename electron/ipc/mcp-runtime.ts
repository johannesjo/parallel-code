import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { IPC } from './channels.js';
import type { Notify } from './notify.js';
import { onPtyEvent } from './pty.js';
import { appendGitInfoExcludeBlock } from './git-exclude.js';
import { loadAppState, saveAppState } from './persistence.js';
import { getDockerMcpServerDestPath, hostMcpServerPath } from './mcp-paths.js';
import {
  createRemoteTransport,
  type RemoteServerOptions,
  type RemoteTransport,
} from './remote-transport.js';
import { DelegationService } from '../mcp/delegation.js';
import type { Coordinator } from '../mcp/coordinator.js';
import { removeCanvasConfig } from '../mcp/canvas-config.js';
import { getMCPRemoteServerUrl } from '../mcp/config.js';
import type { TaskAuthorityInput } from '../shared/delegation-types.js';
import { warn as logWarn, errMessage } from '../log.js';

export interface McpRuntimeOptions {
  notify: Notify;
  defaultPort: number;
  serverOptions: () => RemoteServerOptions;
  rememberedDevicesPath: () => string;
  /** Runs once, when the coordinator first loads; its IPC handlers are registered here. */
  onCoordinatorLoaded: () => void;
}

export interface McpRuntime {
  transport: RemoteTransport;
  delegation: DelegationService;
  /** A kill must also cancel startup while optional MCP transport is awaiting I/O. */
  pendingSpawns: Map<string, { sessionInstanceId: string }>;
  /** Which spawn minted the agent's live canvas token. `pendingSpawns` cannot answer this: a
   *  kill clears the entry to cancel the spawn, and a finished restart clears its own, so an
   *  absent entry means both "nobody owns this" and "the owner already left". */
  canvasOwners: Map<string, { sessionInstanceId: string }>;
  /** Container agents on macOS reach the host only through a wide bind; track who needs it. */
  wideBindAgents: Set<string>;
  needsWideBind: (dockerMode: boolean) => boolean;
  /** The coordinator, or null until `ensureCoordinator` has loaded it. It is never unloaded. */
  coordinator(): Coordinator | null;
  /** Lazily loads the shared coordination backend. Safe to call multiple times. */
  ensureCoordinator(): Promise<void>;
}

function restoreOrchestrationEnabled(): boolean {
  try {
    const saved = loadAppState();
    return saved ? JSON.parse(saved).mcpOrchestrationEnabled !== false : true;
  } catch (error) {
    logWarn('mcp', 'Could not restore orchestration setting; keeping orchestration disabled', {
      err: errMessage(error),
    });
    return false;
  }
}

/**
 * The MCP side of the main process: the remote transport, the lazily loaded
 * coordinator, delegation, and which agents hold canvas tokens or a wide bind.
 */
export function createMcpRuntime(opts: McpRuntimeOptions): McpRuntime {
  const { notify } = opts;
  let coordinator: Coordinator | null = null;
  const pendingSpawns = new Map<string, { sessionInstanceId: string }>();
  const canvasOwners = new Map<string, { sessionInstanceId: string }>();
  const wideBindAgents = new Set<string>();
  const needsWideBind = (dockerMode: boolean) => dockerMode && process.platform !== 'linux';

  const transport = createRemoteTransport({
    defaultPort: opts.defaultPort,
    serverOptions: opts.serverOptions,
    coordinator: () => coordinator,
    needsWideBind,
    wideBindInUse: () =>
      wideBindAgents.size > 0 ||
      (process.platform !== 'linux' && delegation.requiresWideTransport()),
    rememberedDevicesPath: opts.rememberedDevicesPath,
  });

  const delegation: DelegationService = new DelegationService({
    orchestrationEnabled: restoreOrchestrationEnabled(),
    coordinator: async () => {
      await ensureCoordinator();
      if (!coordinator) throw new Error('Delegation unavailable.');
      return coordinator;
    },
    currentCoordinator: () => coordinator,
    prepareParent: prepareDelegationParent,
    sessions: () => transport.current()?.getSessionAgents() ?? [],
    changed: (event) => notify(IPC.DelegationChanged, event),
    persist: () => {
      const json = loadAppState();
      if (json) saveAppState(delegation.normalizeState(json));
    },
    parentCreated: (taskId) => notify(IPC.MCP_TaskStateSync, { taskId, delegationParent: true }),
  });

  async function prepareDelegationParent(task: TaskAuthorityInput): Promise<void> {
    await ensureCoordinator();
    if (!coordinator) throw new Error('Delegation unavailable.');
    const server = await transport.ensureForMcp(task.dockerMode === true);
    const hostServerPath = hostMcpServerPath();
    const serverPath = task.dockerMode
      ? getDockerMcpServerDestPath(task.worktreePath, task.projectRoot)
      : hostServerPath;
    if (task.dockerMode) {
      fs.mkdirSync(path.dirname(serverPath), { recursive: true });
      fs.copyFileSync(hostServerPath, serverPath);
      appendGitInfoExcludeBlock(
        task.worktreePath,
        '.parallel-code/',
        '# Parallel Code MCP runtime\n.parallel-code/\n',
        (error) =>
          logWarn('mcp', 'Could not exclude MCP runtime directory', { err: errMessage(error) }),
      );
    }
    coordinator.registerCoordinator(task.taskId, task.projectId, {
      projectRoot: task.projectRoot,
      worktreePath: task.worktreePath,
      branchName: task.branchName,
      spawnDefaults: { command: task.agentCommand, args: task.agentArgs },
      agentEnvFile: task.agentEnvFile,
      automaticNotifications: task.autoSendChildUpdates ?? task.coordinatorMode ?? false,
      paused: task.delegationPaused,
      skipPermissions: task.propagateSkipPermissions,
      maxConcurrentTasks: task.maxConcurrentTasks,
      verifyCommand: task.verifyCommand,
    });
    coordinator.setDockerContainerName(task.taskId, task.dockerMode ? 'delegation' : null);
    coordinator.setDockerImage(task.taskId, task.dockerImage ?? null);
    coordinator.setMCPServerInfo(
      task.taskId,
      getMCPRemoteServerUrl(server.port, task.dockerMode ? 'delegation' : undefined),
      server.coordinatorTokenFor(task.taskId),
      server.subtaskToken,
      serverPath,
    );
  }

  // The canvas token is revoked on exit; the config file holding it must go too.
  onPtyEvent('exit', (agentId) => {
    try {
      removeCanvasConfig(agentId);
    } catch (error) {
      console.warn('Could not remove canvas MCP credentials:', error);
    }
    wideBindAgents.delete(agentId);
    canvasOwners.delete(agentId);
    // The server's own exit listener runs after this one; drop the agent here so the
    // idle check below already sees it gone.
    transport.current()?.unregisterCanvasAgent(agentId);
    delegation.expireMessages();
    transport
      .stopIfIdle()
      .catch((error) => console.warn('[MCP] Could not stop the idle transport:', error));
  });

  let coordinatorStarting: Promise<void> | undefined;
  async function ensureCoordinator(): Promise<void> {
    if (coordinator) return;
    if (coordinatorStarting) return coordinatorStarting;
    coordinatorStarting = (async () => {
      const { Coordinator } = await import('../mcp/coordinator.js');
      const loaded = new Coordinator();
      coordinator = loaded;
      loaded.setOrchestrationEnabled(delegation.isOrchestrationEnabled());
      loaded.setNotify(notify);
      loaded.setSessionMcpProvider((task) => {
        const server = transport.current();
        if (!delegation.getTask(task.coordinatorTaskId) || !server) return undefined;
        if (!delegation.getTask(task.id)) {
          if (task.status !== 'creating')
            throw new Error('Task authority was not validated before restoring its MCP session.');
          delegation.registerChild(task);
        }
        const sessionCapabilities = delegation.capabilities(task.id);
        if (!sessionCapabilities) throw new Error('Task authority is unavailable.');
        let owner = canvasOwners.get(task.agentId);
        if (!owner) {
          owner = { sessionInstanceId: crypto.randomUUID() };
          canvasOwners.set(task.agentId, owner);
        }
        if (needsWideBind(!!task.dockerContainerName)) wideBindAgents.add(task.agentId);
        const token = server.registerCanvasAgent(task.id, task.agentId, undefined, {
          sessionInstanceId: owner.sessionInstanceId,
          capabilities: sessionCapabilities,
        });
        return { token, sessionCapabilities };
      });
      opts.onCoordinatorLoaded();
    })();
    try {
      await coordinatorStarting;
    } finally {
      coordinatorStarting = undefined;
    }
  }

  return {
    transport,
    delegation,
    pendingSpawns,
    canvasOwners,
    wideBindAgents,
    needsWideBind,
    coordinator: () => coordinator,
    ensureCoordinator,
  };
}
