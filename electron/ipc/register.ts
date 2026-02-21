import { ipcMain, dialog, shell, BrowserWindow } from "electron";
import { IPC } from "./channels.js";
import {
  spawnAgent,
  writeToAgent,
  resizeAgent,
  pauseAgent,
  resumeAgent,
  killAgent,
  countRunningAgents,
  killAllAgents,
} from "./pty.js";
import {
  getGitIgnoredDirs,
  getMainBranch,
  getCurrentBranch,
  getChangedFiles,
  getFileDiff,
  getWorktreeStatus,
  checkMergeStatus,
  mergeTask,
  getBranchLog,
  pushTask,
  rebaseTask,
} from "./git.js";
import { createTask, deleteTask } from "./tasks.js";
import { listAgents } from "./agents.js";
import { saveAppState, loadAppState } from "./persistence.js";
import path from "path";

/** Reject paths that are non-absolute or attempt directory traversal. */
function validatePath(p: unknown, label: string): void {
  if (typeof p !== "string") throw new Error(`${label} must be a string`);
  if (!path.isAbsolute(p)) throw new Error(`${label} must be absolute`);
  if (p.includes("..")) throw new Error(`${label} must not contain ".."`);
}

/** Reject relative paths that attempt directory traversal. */
function validateRelativePath(p: unknown, label: string): void {
  if (typeof p !== "string") throw new Error(`${label} must be a string`);
  if (p.includes("..")) throw new Error(`${label} must not contain ".."`);
}

/** Reject branch names that could be misinterpreted as git flags. */
function validateBranchName(name: unknown, label: string): void {
  if (typeof name !== "string" || !name) throw new Error(`${label} must be a non-empty string`);
  if (name.startsWith("-")) throw new Error(`${label} must not start with "-"`);
}

export function registerAllHandlers(win: BrowserWindow): void {
  // --- PTY commands ---
  ipcMain.handle(IPC.SpawnAgent, (_e, args) => {
    validatePath(args.cwd, "cwd");
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
    validatePath(args.projectRoot, "projectRoot");
    return createTask(args.name, args.projectRoot, args.symlinkDirs, args.branchPrefix);
  });
  ipcMain.handle(IPC.DeleteTask, (_e, args) => {
    validatePath(args.projectRoot, "projectRoot");
    validateBranchName(args.branchName, "branchName");
    return deleteTask(args.agentIds, args.branchName, args.deleteBranch, args.projectRoot);
  });

  // --- Git commands ---
  ipcMain.handle(IPC.GetChangedFiles, (_e, args) => {
    validatePath(args.worktreePath, "worktreePath");
    return getChangedFiles(args.worktreePath);
  });
  ipcMain.handle(IPC.GetFileDiff, (_e, args) => {
    validatePath(args.worktreePath, "worktreePath");
    validateRelativePath(args.filePath, "filePath");
    return getFileDiff(args.worktreePath, args.filePath);
  });
  ipcMain.handle(IPC.GetGitignoredDirs, (_e, args) => {
    validatePath(args.projectRoot, "projectRoot");
    return getGitIgnoredDirs(args.projectRoot);
  });
  ipcMain.handle(IPC.GetWorktreeStatus, (_e, args) => {
    validatePath(args.worktreePath, "worktreePath");
    return getWorktreeStatus(args.worktreePath);
  });
  ipcMain.handle(IPC.CheckMergeStatus, (_e, args) => {
    validatePath(args.worktreePath, "worktreePath");
    return checkMergeStatus(args.worktreePath);
  });
  ipcMain.handle(IPC.MergeTask, (_e, args) => {
    validatePath(args.projectRoot, "projectRoot");
    validateBranchName(args.branchName, "branchName");
    return mergeTask(args.projectRoot, args.branchName, args.squash, args.message, args.cleanup);
  });
  ipcMain.handle(IPC.GetBranchLog, (_e, args) => {
    validatePath(args.worktreePath, "worktreePath");
    return getBranchLog(args.worktreePath);
  });
  ipcMain.handle(IPC.PushTask, (_e, args) => {
    validatePath(args.projectRoot, "projectRoot");
    validateBranchName(args.branchName, "branchName");
    return pushTask(args.projectRoot, args.branchName);
  });
  ipcMain.handle(IPC.RebaseTask, (_e, args) => {
    validatePath(args.worktreePath, "worktreePath");
    return rebaseTask(args.worktreePath);
  });
  ipcMain.handle(IPC.GetMainBranch, (_e, args) => {
    validatePath(args.projectRoot, "projectRoot");
    return getMainBranch(args.projectRoot);
  });
  ipcMain.handle(IPC.GetCurrentBranch, (_e, args) => {
    validatePath(args.projectRoot, "projectRoot");
    return getCurrentBranch(args.projectRoot);
  });

  // --- Persistence ---
  ipcMain.handle(IPC.SaveAppState, (_e, args) => saveAppState(args.json));
  ipcMain.handle(IPC.LoadAppState, () => loadAppState());

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
  ipcMain.handle(IPC.WindowSetSize, (_e, args) =>
    win.setSize(args.width, args.height)
  );
  ipcMain.handle(IPC.WindowSetPosition, (_e, args) =>
    win.setPosition(args.x, args.y)
  );
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
      type: args.kind === "warning" ? "warning" : "question",
      title: args.title || "Confirm",
      message: args.message,
      buttons: [args.okLabel || "OK", args.cancelLabel || "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    return result.response === 0;
  });

  ipcMain.handle(IPC.DialogOpen, async (_e, args) => {
    const properties: Array<
      "openDirectory" | "openFile" | "multiSelections"
    > = [];
    if (args?.directory) properties.push("openDirectory");
    else properties.push("openFile");
    if (args?.multiple) properties.push("multiSelections");
    const result = await dialog.showOpenDialog(win, { properties });
    if (result.canceled) return null;
    return args?.multiple ? result.filePaths : result.filePaths[0] ?? null;
  });

  // --- Shell/Opener ---
  ipcMain.handle(IPC.ShellReveal, (_e, args) => {
    validatePath(args.filePath, "filePath");
    shell.showItemInFolder(args.filePath);
  });

  // --- Forward window events to renderer ---
  win.on("focus", () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.WindowFocus);
  });
  win.on("blur", () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.WindowBlur);
  });
  win.on("resize", () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.WindowResized);
  });
  win.on("move", () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.WindowMoved);
  });
  win.on("close", (e) => {
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
