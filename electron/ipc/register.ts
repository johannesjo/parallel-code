import { ipcMain, dialog, shell, BrowserWindow } from "electron";
import {
  spawnAgent,
  writeToAgent,
  resizeAgent,
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

export function registerAllHandlers(win: BrowserWindow): void {
  // --- PTY commands ---
  ipcMain.handle("spawn_agent", (_e, args) => spawnAgent(win, args));
  ipcMain.handle("write_to_agent", (_e, args) => writeToAgent(args.agentId, args.data));
  ipcMain.handle("resize_agent", (_e, args) => resizeAgent(args.agentId, args.cols, args.rows));
  ipcMain.handle("kill_agent", (_e, args) => killAgent(args.agentId));
  ipcMain.handle("count_running_agents", () => countRunningAgents());
  ipcMain.handle("kill_all_agents", () => killAllAgents());

  // --- Agent commands ---
  ipcMain.handle("list_agents", () => listAgents());

  // --- Task commands ---
  ipcMain.handle("create_task", (_e, args) =>
    createTask(args.name, args.projectRoot, args.symlinkDirs, args.branchPrefix)
  );
  ipcMain.handle("delete_task", (_e, args) =>
    deleteTask(args.agentIds, args.branchName, args.deleteBranch, args.projectRoot)
  );

  // --- Git commands ---
  ipcMain.handle("get_changed_files", (_e, args) => getChangedFiles(args.worktreePath));
  ipcMain.handle("get_file_diff", (_e, args) => getFileDiff(args.worktreePath, args.filePath));
  ipcMain.handle("get_gitignored_dirs", (_e, args) => getGitIgnoredDirs(args.projectRoot));
  ipcMain.handle("get_worktree_status", (_e, args) => getWorktreeStatus(args.worktreePath));
  ipcMain.handle("check_merge_status", (_e, args) => checkMergeStatus(args.worktreePath));
  ipcMain.handle("merge_task", (_e, args) =>
    mergeTask(args.projectRoot, args.branchName, args.squash, args.message, args.cleanup)
  );
  ipcMain.handle("get_branch_log", (_e, args) => getBranchLog(args.worktreePath));
  ipcMain.handle("push_task", (_e, args) => pushTask(args.projectRoot, args.branchName));
  ipcMain.handle("rebase_task", (_e, args) => rebaseTask(args.worktreePath));
  ipcMain.handle("get_main_branch", (_e, args) => getMainBranch(args.projectRoot));
  ipcMain.handle("get_current_branch", (_e, args) => getCurrentBranch(args.projectRoot));

  // --- Persistence ---
  ipcMain.handle("save_app_state", (_e, args) => saveAppState(args.json));
  ipcMain.handle("load_app_state", () => loadAppState());

  // --- Window management ---
  ipcMain.handle("__window_is_focused", () => win.isFocused());
  ipcMain.handle("__window_is_maximized", () => win.isMaximized());
  ipcMain.handle("__window_minimize", () => win.minimize());
  ipcMain.handle("__window_toggle_maximize", () => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle("__window_close", () => win.close());
  ipcMain.handle("__window_force_close", () => win.destroy());
  ipcMain.handle("__window_hide", () => win.hide());
  ipcMain.handle("__window_maximize", () => win.maximize());
  ipcMain.handle("__window_unmaximize", () => win.unmaximize());
  ipcMain.handle("__window_set_size", (_e, args) =>
    win.setSize(args.width, args.height)
  );
  ipcMain.handle("__window_set_position", (_e, args) =>
    win.setPosition(args.x, args.y)
  );
  ipcMain.handle("__window_get_position", () => {
    const [x, y] = win.getPosition();
    return { x, y };
  });
  ipcMain.handle("__window_get_size", () => {
    const [width, height] = win.getSize();
    return { width, height };
  });

  // --- Dialog ---
  ipcMain.handle("__dialog_confirm", async (_e, args) => {
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

  ipcMain.handle("__dialog_open", async (_e, args) => {
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
  ipcMain.handle("__shell_reveal", (_e, filePath) => {
    shell.showItemInFolder(filePath as string);
  });

  // --- Forward window events to renderer ---
  win.on("focus", () => {
    if (!win.isDestroyed()) win.webContents.send("__window_focus");
  });
  win.on("blur", () => {
    if (!win.isDestroyed()) win.webContents.send("__window_blur");
  });
  win.on("resize", () => {
    if (!win.isDestroyed()) win.webContents.send("__window_resized");
  });
  win.on("move", () => {
    if (!win.isDestroyed()) win.webContents.send("__window_moved");
  });
  win.on("close", (e) => {
    e.preventDefault();
    if (!win.isDestroyed()) win.webContents.send("__window_close_requested");
  });
}
