import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { IPC } from './channels.js';
import {
  spawnAgent,
  writeToAgent,
  resizeAgent,
  pauseAgent,
  resumeAgent,
  killAgent,
  countRunningAgents,
  killAllAgents,
  getAgentMeta,
} from './pty.js';
import { startRemoteServer } from '../remote/server.js';
import {
  getGitIgnoredDirs,
  getMainBranch,
  getCurrentBranch,
  getChangedFiles,
  getChangedFilesFromBranch,
  getFileDiff,
  getFileDiffFromBranch,
  getWorktreeStatus,
  commitAll,
  discardUncommitted,
  checkMergeStatus,
  mergeTask,
  getBranchLog,
  pushTask,
  rebaseTask,
  createWorktree,
  removeWorktree,
} from './git.js';
import { createTask, deleteTask } from './tasks.js';
import { listAgents } from './agents.js';
import { saveAppState, loadAppState } from './persistence.js';
import path from 'path';

/** Reject paths that are non-absolute or attempt directory traversal. */
function validatePath(p: unknown, label: string): void {
  if (typeof p !== 'string') throw new Error(`${label} must be a string`);
  if (!path.isAbsolute(p)) throw new Error(`${label} must be absolute`);
  if (p.includes('..')) throw new Error(`${label} must not contain ".."`);
}

/** Reject relative paths that attempt directory traversal. */
function validateRelativePath(p: unknown, label: string): void {
  if (typeof p !== 'string') throw new Error(`${label} must be a string`);
  if (p.includes('..')) throw new Error(`${label} must not contain ".."`);
}

/** Reject branch names that could be misinterpreted as git flags. */
function validateBranchName(name: unknown, label: string): void {
  if (typeof name !== 'string' || !name) throw new Error(`${label} must be a non-empty string`);
  if (name.startsWith('-')) throw new Error(`${label} must not start with "-"`);
}

export function registerAllHandlers(win: BrowserWindow): void {
  // --- Remote access state ---
  let remoteServer: ReturnType<typeof startRemoteServer> | null = null;
  const taskNames = new Map<string, string>();

  // --- PTY commands ---
  ipcMain.handle(IPC.SpawnAgent, (_e, args) => {
    if (args.cwd) validatePath(args.cwd, 'cwd');
    return spawnAgent(win, args);
  });
  ipcMain.handle(IPC.WriteToAgent, (_e, args) => writeToAgent(args.agentId, args.data));
  ipcMain.handle(IPC.ResizeAgent, (_e, args) => resizeAgent(args.agentId, args.cols, args.rows));
  ipcMain.handle(IPC.PauseAgent, (_e, args) => pauseAgent(args.agentId));
  ipcMain.handle(IPC.ResumeAgent, (_e, args) => resumeAgent(args.agentId));
  ipcMain.handle(IPC.KillAgent, (_e, args) => killAgent(args.agentId));
  ipcMain.handle(IPC.CountRunningAgents, () => countRunningAgents());
  ipcMain.handle(IPC.KillAllAgents, () => killAllAgents());

  // --- Agent commands ---
  ipcMain.handle(IPC.ListAgents, () => listAgents());

  // --- Task commands ---
  ipcMain.handle(IPC.CreateTask, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    const result = createTask(args.name, args.projectRoot, args.symlinkDirs, args.branchPrefix);
    result.then((r: { id: string }) => taskNames.set(r.id, args.name)).catch(() => {});
    return result;
  });
  ipcMain.handle(IPC.DeleteTask, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    validateBranchName(args.branchName, 'branchName');
    return deleteTask(args.agentIds, args.branchName, args.deleteBranch, args.projectRoot);
  });

  // --- Git commands ---
  ipcMain.handle(IPC.GetChangedFiles, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    return getChangedFiles(args.worktreePath);
  });
  ipcMain.handle(IPC.GetChangedFilesFromBranch, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    validateBranchName(args.branchName, 'branchName');
    return getChangedFilesFromBranch(args.projectRoot, args.branchName);
  });
  ipcMain.handle(IPC.GetFileDiff, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    validateRelativePath(args.filePath, 'filePath');
    return getFileDiff(args.worktreePath, args.filePath);
  });
  ipcMain.handle(IPC.GetFileDiffFromBranch, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    validateBranchName(args.branchName, 'branchName');
    validateRelativePath(args.filePath, 'filePath');
    return getFileDiffFromBranch(args.projectRoot, args.branchName, args.filePath);
  });
  ipcMain.handle(IPC.GetGitignoredDirs, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    return getGitIgnoredDirs(args.projectRoot);
  });
  ipcMain.handle(IPC.GetWorktreeStatus, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    return getWorktreeStatus(args.worktreePath);
  });
  ipcMain.handle(IPC.CommitAll, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    return commitAll(args.worktreePath, args.message);
  });
  ipcMain.handle(IPC.DiscardUncommitted, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    return discardUncommitted(args.worktreePath);
  });
  ipcMain.handle(IPC.CheckMergeStatus, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    return checkMergeStatus(args.worktreePath);
  });
  ipcMain.handle(IPC.MergeTask, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    validateBranchName(args.branchName, 'branchName');
    return mergeTask(args.projectRoot, args.branchName, args.squash, args.message, args.cleanup);
  });
  ipcMain.handle(IPC.GetBranchLog, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    return getBranchLog(args.worktreePath);
  });
  ipcMain.handle(IPC.PushTask, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    validateBranchName(args.branchName, 'branchName');
    return pushTask(args.projectRoot, args.branchName);
  });
  ipcMain.handle(IPC.RebaseTask, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    return rebaseTask(args.worktreePath);
  });
  ipcMain.handle(IPC.GetMainBranch, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    return getMainBranch(args.projectRoot);
  });
  ipcMain.handle(IPC.GetCurrentBranch, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    return getCurrentBranch(args.projectRoot);
  });

  // --- Persistence ---
  // Extract task names from persisted state so the remote server can
  // show them (taskNames is only populated on CreateTask otherwise).
  function syncTaskNamesFromJson(json: string): void {
    try {
      const state = JSON.parse(json) as { tasks?: Record<string, { id: string; name: string }> };
      if (state.tasks) {
        for (const t of Object.values(state.tasks)) {
          if (t.id && t.name) taskNames.set(t.id, t.name);
        }
      }
    } catch {
      /* ignore malformed state */
    }
  }
  ipcMain.handle(IPC.SaveAppState, (_e, args) => {
    syncTaskNamesFromJson(args.json);
    return saveAppState(args.json);
  });
  ipcMain.handle(IPC.LoadAppState, () => {
    const json = loadAppState();
    if (json) syncTaskNamesFromJson(json);
    return json;
  });

  // --- Arena persistence ---
  ipcMain.handle(IPC.SaveArenaData, (_e, args) => {
    const filePath = path.join(app.getPath('userData'), args.filename);
    const basename = path.basename(filePath);
    if (basename !== args.filename) throw new Error('Invalid filename');
    if (!basename.startsWith('arena-') || !basename.endsWith('.json'))
      throw new Error('Arena files must be arena-*.json');
    fs.writeFileSync(filePath, args.json, 'utf-8');
  });

  ipcMain.handle(IPC.LoadArenaData, (_e, args) => {
    const filePath = path.join(app.getPath('userData'), args.filename);
    const basename = path.basename(filePath);
    if (basename !== args.filename) throw new Error('Invalid filename');
    if (!basename.startsWith('arena-') || !basename.endsWith('.json'))
      throw new Error('Arena files must be arena-*.json');
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC.CreateArenaWorktree, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    validateBranchName(args.branchName, 'branchName');
    return createWorktree(args.projectRoot, args.branchName, args.symlinkDirs ?? [], true);
  });

  ipcMain.handle(IPC.RemoveArenaWorktree, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    validateBranchName(args.branchName, 'branchName');
    return removeWorktree(args.projectRoot, args.branchName, true);
  });

  ipcMain.handle(IPC.CheckPathExists, (_e, args) => {
    validatePath(args.path, 'path');
    return fs.existsSync(args.path);
  });

  // --- Window management ---
  ipcMain.handle(IPC.WindowIsFocused, () => win.isFocused());
  ipcMain.handle(IPC.WindowIsMaximized, () => win.isMaximized());
  ipcMain.handle(IPC.WindowMinimize, () => win.minimize());
  ipcMain.handle(IPC.WindowToggleMaximize, () => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle(IPC.WindowClose, () => win.close());
  ipcMain.handle(IPC.WindowForceClose, () => win.destroy());
  ipcMain.handle(IPC.WindowHide, () => win.hide());
  ipcMain.handle(IPC.WindowMaximize, () => win.maximize());
  ipcMain.handle(IPC.WindowUnmaximize, () => win.unmaximize());
  ipcMain.handle(IPC.WindowSetSize, (_e, args) => win.setSize(args.width, args.height));
  ipcMain.handle(IPC.WindowSetPosition, (_e, args) => win.setPosition(args.x, args.y));
  ipcMain.handle(IPC.WindowGetPosition, () => {
    const [x, y] = win.getPosition();
    return { x, y };
  });
  ipcMain.handle(IPC.WindowGetSize, () => {
    const [width, height] = win.getSize();
    return { width, height };
  });

  // --- Dialog ---
  ipcMain.handle(IPC.DialogConfirm, async (_e, args) => {
    const result = await dialog.showMessageBox(win, {
      type: args.kind === 'warning' ? 'warning' : 'question',
      title: args.title || 'Confirm',
      message: args.message,
      buttons: [args.okLabel || 'OK', args.cancelLabel || 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    return result.response === 0;
  });

  ipcMain.handle(IPC.DialogOpen, async (_e, args) => {
    const properties: Array<'openDirectory' | 'openFile' | 'multiSelections'> = [];
    if (args?.directory) properties.push('openDirectory');
    else properties.push('openFile');
    if (args?.multiple) properties.push('multiSelections');
    const result = await dialog.showOpenDialog(win, { properties });
    if (result.canceled) return null;
    return args?.multiple ? result.filePaths : (result.filePaths[0] ?? null);
  });

  // --- Shell/Opener ---
  ipcMain.handle(IPC.ShellReveal, (_e, args) => {
    validatePath(args.filePath, 'filePath');
    shell.showItemInFolder(args.filePath);
  });

  ipcMain.handle(IPC.ShellOpenFile, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    validateRelativePath(args.filePath, 'filePath');
    return shell.openPath(path.join(args.worktreePath, args.filePath));
  });

  // --- Remote access ---
  ipcMain.handle(IPC.StartRemoteServer, (_e, args: { port?: number }) => {
    if (remoteServer)
      return {
        url: remoteServer.url,
        wifiUrl: remoteServer.wifiUrl,
        tailscaleUrl: remoteServer.tailscaleUrl,
        token: remoteServer.token,
        port: remoteServer.port,
      };

    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const distRemote = path.join(thisDir, '..', '..', 'dist-remote');
    remoteServer = startRemoteServer({
      port: args.port ?? 7777,
      staticDir: distRemote,
      getTaskName: (taskId: string) => taskNames.get(taskId) ?? taskId,
      getAgentStatus: (agentId: string) => {
        const meta = getAgentMeta(agentId);
        return {
          status: meta ? ('running' as const) : ('exited' as const),
          exitCode: null,
          lastLine: '',
        };
      },
    });
    return {
      url: remoteServer.url,
      wifiUrl: remoteServer.wifiUrl,
      tailscaleUrl: remoteServer.tailscaleUrl,
      token: remoteServer.token,
      port: remoteServer.port,
    };
  });

  ipcMain.handle(IPC.StopRemoteServer, async () => {
    if (remoteServer) {
      await remoteServer.stop();
      remoteServer = null;
    }
  });

  ipcMain.handle(IPC.GetRemoteStatus, () => {
    if (!remoteServer) return { enabled: false, connectedClients: 0 };
    return {
      enabled: true,
      connectedClients: remoteServer.connectedClients(),
      url: remoteServer.url,
      wifiUrl: remoteServer.wifiUrl,
      tailscaleUrl: remoteServer.tailscaleUrl,
      token: remoteServer.token,
      port: remoteServer.port,
    };
  });

  // --- Forward window events to renderer ---
  win.on('focus', () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.WindowFocus);
  });
  win.on('blur', () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.WindowBlur);
  });
  win.on('resize', () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.WindowResized);
  });
  win.on('move', () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.WindowMoved);
  });
  win.on('close', (e) => {
    e.preventDefault();
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.WindowCloseRequested);
      // Fallback: force-close if renderer doesn't respond within 5 seconds.
      // If the renderer calls WindowForceClose first, win.isDestroyed()
      // will be true and this is a no-op.
      setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, 5_000);
    }
  });
}
