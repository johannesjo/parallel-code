import { ipcMain, dialog, shell, app, clipboard, BrowserWindow, Notification } from 'electron';
import fs from 'fs';
import os from 'os';
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
  isDockerAvailable,
  dockerImageExists,
  buildDockerImage,
  resolveProjectDockerfile,
  projectImageTag,
} from './pty.js';
import {
  ensurePlansDirectory,
  startPlanWatcher,
  stopPlanWatcher,
  readPlanForWorktree,
} from './plans.js';
import { startStepsWatcher, stopStepsWatcher, readStepsForWorktree } from './steps.js';
import { initPrChecks, startPrChecksWatcher, stopPrChecksWatcher, isPrUrl } from './pr-checks.js';
import { readCoverageSummary } from './coverage.js';
import { startRemoteServer, getMCPLogs } from '../remote/server.js';
import { Orchestrator } from '../mcp/orchestrator.js';
import {
  getGitIgnoredDirs,
  getMainBranch,
  getCurrentBranch,
  getChangedFiles,
  getChangedFilesFromBranch,
  getAllFileDiffs,
  getAllFileDiffsFromBranch,
  getFileDiff,
  getFileDiffFromBranch,
  getWorktreeStatus,
  listImportableWorktrees,
  commitAll,
  discardUncommitted,
  checkMergeStatus,
  mergeTask,
  getBranchLog,
  pushTask,
  rebaseTask,
  createWorktree,
  removeWorktree,
  isGitRepo,
  getBranches,
  checkoutBranch,
  getBranchCommits,
  getCommitChangedFiles,
  getCommitDiffs,
} from './git.js';
import { createTask, deleteTask } from './tasks.js';
import { listAgents } from './agents.js';
import { saveAppState, loadAppState } from './persistence.js';
import { loadKeybindings, saveKeybindings } from './keybindings.js';
import { spawn } from 'child_process';
import { askAboutCode, cancelAskAboutCode } from './ask-code.js';
import { setMinimaxApiKey } from './ask-code-minimax.js';
import { getSystemMonospaceFonts } from './system-fonts.js';
import path from 'path';
import {
  assertString,
  assertInt,
  assertBoolean,
  assertStringArray,
  assertOptionalString,
  assertOptionalBoolean,
} from './validate.js';
import { warn as logWarn } from '../log.js';

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Reject paths that are non-absolute or attempt directory traversal. */
function validatePath(p: unknown, label: string): void {
  if (typeof p !== 'string') throw new Error(`${label} must be a string`);
  if (!path.isAbsolute(p)) throw new Error(`${label} must be absolute`);
  if (p.includes('..')) throw new Error(`${label} must not contain ".."`);
}

/** Reject relative paths that attempt directory traversal or are absolute. */
function validateRelativePath(p: unknown, label: string): void {
  if (typeof p !== 'string') throw new Error(`${label} must be a string`);
  if (path.isAbsolute(p)) throw new Error(`${label} must not be absolute`);
  if (p.includes('..')) throw new Error(`${label} must not contain ".."`);
}

/** Reject branch names that could be misinterpreted as git flags. */
function validateBranchName(name: unknown, label: string): void {
  if (typeof name !== 'string' || !name) throw new Error(`${label} must be a non-empty string`);
  if (name.startsWith('-')) throw new Error(`${label} must not start with "-"`);
}

/** Reject commit hashes that are not valid hex strings. */
function validateCommitHash(hash: unknown, label: string): void {
  if (typeof hash !== 'string') throw new Error(`${label} must be a string`);
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new Error(`${label} must be a valid hex commit hash`);
}

function getOptionalDockerfilePath(value: unknown): string | undefined {
  assertOptionalString(value, 'dockerfilePath');
  if (value !== undefined) validatePath(value, 'dockerfilePath');
  return value;
}

function getOptionalBuildContext(value: unknown): string | undefined {
  assertOptionalString(value, 'buildContext');
  if (value !== undefined) validatePath(value, 'buildContext');
  return value;
}

function getOptionalImageTag(value: unknown): string | undefined {
  assertOptionalString(value, 'imageTag');
  const imageTag = value?.trim();
  if (imageTag === '') throw new Error('imageTag must be a non-empty string');
  return imageTag;
}

/**
 * Create a leading+trailing throttled event forwarder.
 * Fires immediately, suppresses for `intervalMs`, then fires once more
 * if events arrived during suppression (ensures the final state is always forwarded).
 */
function createThrottledForwarder(
  win: BrowserWindow,
  channel: string,
  intervalMs: number,
): () => void {
  let throttled = false;
  let pending = false;
  return () => {
    if (win.isDestroyed()) return;
    if (throttled) {
      pending = true;
      return;
    }
    throttled = true;
    win.webContents.send(channel);
    setTimeout(() => {
      throttled = false;
      if (pending) {
        pending = false;
        if (!win.isDestroyed()) win.webContents.send(channel);
      }
    }, intervalMs);
  };
}

export function registerAllHandlers(win: BrowserWindow): void {
  // --- Remote access state ---
  let remoteServer: ReturnType<typeof startRemoteServer> | null = null;
  const taskNames = new Map<string, string>();

  // --- MCP orchestrator ---
  const orchestrator = new Orchestrator();
  orchestrator.setWindow(win);

  // --- PTY commands ---
  ipcMain.handle(IPC.SpawnAgent, (_e, args) => {
    assertString(args.command, 'command');
    assertStringArray(args.args, 'args');
    assertString(args.taskId, 'taskId');
    assertString(args.agentId, 'agentId');
    assertInt(args.cols, 'cols');
    assertInt(args.rows, 'rows');
    assertOptionalBoolean(args.dockerMode, 'dockerMode');
    assertOptionalString(args.dockerImage, 'dockerImage');
    assertOptionalBoolean(args.shareDockerAgentAuth, 'shareDockerAgentAuth');
    assertOptionalBoolean(args.stepsEnabled, 'stepsEnabled');
    if (args.cwd) validatePath(args.cwd, 'cwd');
    if (!args.isShell && args.cwd) {
      try {
        ensurePlansDirectory(args.cwd);
      } catch (err) {
        console.warn('Failed to set up plans directory:', err);
      }
    }
    const result = spawnAgent(win, args);
    if (!args.isShell && args.cwd) {
      try {
        startPlanWatcher(win, args.taskId, args.cwd);
      } catch (err) {
        console.warn('Failed to start plan watcher:', err);
      }
      if (args.stepsEnabled) {
        try {
          startStepsWatcher(win, args.taskId, args.cwd);
        } catch (err) {
          console.warn('Failed to start steps watcher:', err);
        }
      }
    }
    return result;
  });
  ipcMain.handle(IPC.WriteToAgent, (_e, args) => {
    assertString(args.agentId, 'agentId');
    assertString(args.data, 'data');
    return writeToAgent(args.agentId, args.data);
  });
  ipcMain.handle(IPC.ResizeAgent, (_e, args) => {
    assertString(args.agentId, 'agentId');
    assertInt(args.cols, 'cols');
    assertInt(args.rows, 'rows');
    return resizeAgent(args.agentId, args.cols, args.rows);
  });
  ipcMain.handle(IPC.PauseAgent, (_e, args) => {
    assertString(args.agentId, 'agentId');
    return pauseAgent(args.agentId);
  });
  ipcMain.handle(IPC.ResumeAgent, (_e, args) => {
    assertString(args.agentId, 'agentId');
    return resumeAgent(args.agentId);
  });
  ipcMain.handle(IPC.KillAgent, (_e, args) => {
    assertString(args.agentId, 'agentId');
    return killAgent(args.agentId);
  });
  ipcMain.handle(IPC.CountRunningAgents, () => countRunningAgents());
  ipcMain.handle(IPC.KillAllAgents, () => killAllAgents());

  // --- Agent commands ---
  ipcMain.handle(IPC.ListAgents, () => listAgents());
  ipcMain.handle(IPC.CheckDockerAvailable, () => isDockerAvailable());
  ipcMain.handle(IPC.CheckDockerImageExists, (_e, args) => {
    assertString(args.image, 'image');
    const dockerfilePath = getOptionalDockerfilePath(args.dockerfilePath);
    return dockerImageExists(args.image, dockerfilePath ? { dockerfilePath } : undefined);
  });
  ipcMain.handle(IPC.BuildDockerImage, (_e, args) => {
    assertString(args.onOutputChannel, 'onOutputChannel');
    const dockerfilePath = getOptionalDockerfilePath(args.dockerfilePath);
    const buildContext = getOptionalBuildContext(args.buildContext);
    const imageTag = getOptionalImageTag(args.imageTag);
    return buildDockerImage(
      win,
      args.onOutputChannel,
      dockerfilePath || buildContext || imageTag
        ? { dockerfilePath, buildContext, imageTag }
        : undefined,
    );
  });
  ipcMain.handle(IPC.ResolveProjectDockerfile, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    const dockerfilePath = resolveProjectDockerfile(args.projectRoot);
    if (!dockerfilePath) return null;
    return {
      dockerfilePath,
      imageTag: projectImageTag(dockerfilePath),
      buildContext: args.projectRoot,
    };
  });

  // --- Task commands ---
  ipcMain.handle(IPC.CreateTask, (_e, args) => {
    assertString(args.name, 'name');
    validatePath(args.projectRoot, 'projectRoot');
    assertStringArray(args.symlinkDirs, 'symlinkDirs');
    assertOptionalString(args.branchPrefix, 'branchPrefix');
    assertOptionalString(args.baseBranch, 'baseBranch');
    const baseBranch = args.baseBranch || undefined;
    if (baseBranch) validateBranchName(baseBranch, 'baseBranch');
    const result = createTask(
      args.name,
      args.projectRoot,
      args.symlinkDirs,
      args.branchPrefix ?? 'task',
      baseBranch,
    );
    result
      .then((r: { id: string }) => taskNames.set(r.id, args.name))
      .catch((err: unknown) => {
        logWarn('tasks', 'createTask resolution failed', { err: errMessage(err) });
      });
    return result;
  });
  ipcMain.handle(IPC.DeleteTask, (_e, args) => {
    assertStringArray(args.agentIds, 'agentIds');
    validatePath(args.projectRoot, 'projectRoot');
    validateBranchName(args.branchName, 'branchName');
    assertBoolean(args.deleteBranch, 'deleteBranch');
    assertOptionalString(args.taskId, 'taskId');
    return deleteTask({
      taskId: args.taskId,
      agentIds: args.agentIds,
      branchName: args.branchName,
      deleteBranch: args.deleteBranch,
      projectRoot: args.projectRoot,
    });
  });

  // --- Git commands ---
  ipcMain.handle(IPC.GetChangedFiles, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    const baseBranch = args.baseBranch || undefined;
    if (baseBranch) validateBranchName(baseBranch, 'baseBranch');
    return getChangedFiles(args.worktreePath, baseBranch);
  });
  ipcMain.handle(IPC.GetChangedFilesFromBranch, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    validateBranchName(args.branchName, 'branchName');
    const baseBranch = args.baseBranch || undefined;
    if (baseBranch) validateBranchName(baseBranch, 'baseBranch');
    return getChangedFilesFromBranch(args.projectRoot, args.branchName, baseBranch);
  });
  ipcMain.handle(IPC.GetAllFileDiffs, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    const baseBranch = args.baseBranch || undefined;
    if (baseBranch) validateBranchName(baseBranch, 'baseBranch');
    return getAllFileDiffs(args.worktreePath, baseBranch);
  });
  ipcMain.handle(IPC.GetAllFileDiffsFromBranch, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    validateBranchName(args.branchName, 'branchName');
    const baseBranch = args.baseBranch || undefined;
    if (baseBranch) validateBranchName(baseBranch, 'baseBranch');
    return getAllFileDiffsFromBranch(args.projectRoot, args.branchName, baseBranch);
  });
  ipcMain.handle(IPC.GetFileDiff, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    validateRelativePath(args.filePath, 'filePath');
    const baseBranch = args.baseBranch || undefined;
    if (baseBranch) validateBranchName(baseBranch, 'baseBranch');
    return getFileDiff(args.worktreePath, args.filePath, baseBranch);
  });
  ipcMain.handle(IPC.GetFileDiffFromBranch, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    validateBranchName(args.branchName, 'branchName');
    validateRelativePath(args.filePath, 'filePath');
    const baseBranch = args.baseBranch || undefined;
    if (baseBranch) validateBranchName(baseBranch, 'baseBranch');
    return getFileDiffFromBranch(args.projectRoot, args.branchName, args.filePath, baseBranch);
  });
  ipcMain.handle(IPC.GetGitignoredDirs, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    return getGitIgnoredDirs(args.projectRoot);
  });
  ipcMain.handle(IPC.ListImportableWorktrees, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    return listImportableWorktrees(args.projectRoot);
  });
  ipcMain.handle(IPC.GetWorktreeStatus, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    const baseBranch = args.baseBranch || undefined;
    if (baseBranch) validateBranchName(baseBranch, 'baseBranch');
    return getWorktreeStatus(args.worktreePath, baseBranch);
  });
  ipcMain.handle(IPC.CommitAll, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    assertString(args.message, 'message');
    return commitAll(args.worktreePath, args.message);
  });
  ipcMain.handle(IPC.DiscardUncommitted, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    return discardUncommitted(args.worktreePath);
  });
  ipcMain.handle(IPC.CheckMergeStatus, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    const baseBranch = args.baseBranch || undefined;
    if (baseBranch) validateBranchName(baseBranch, 'baseBranch');
    return checkMergeStatus(args.worktreePath, baseBranch);
  });
  ipcMain.handle(IPC.MergeTask, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    validateBranchName(args.branchName, 'branchName');
    assertBoolean(args.squash, 'squash');
    assertOptionalString(args.message, 'message');
    assertOptionalBoolean(args.cleanup, 'cleanup');
    const baseBranch = args.baseBranch || undefined;
    if (baseBranch) validateBranchName(baseBranch, 'baseBranch');
    const worktreePath = args.worktreePath || undefined;
    if (worktreePath) validatePath(worktreePath, 'worktreePath');
    return mergeTask(
      args.projectRoot,
      args.branchName,
      args.squash,
      args.message ?? null,
      args.cleanup ?? false,
      baseBranch,
      worktreePath,
    );
  });
  ipcMain.handle(IPC.GetBranchLog, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    const baseBranch = args.baseBranch || undefined;
    if (baseBranch) validateBranchName(baseBranch, 'baseBranch');
    return getBranchLog(args.worktreePath, baseBranch);
  });
  ipcMain.handle(IPC.GetBranchCommits, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    const baseBranch = args.baseBranch || undefined;
    if (baseBranch) validateBranchName(baseBranch, 'baseBranch');
    return getBranchCommits(args.worktreePath, baseBranch);
  });
  ipcMain.handle(IPC.GetCommitChangedFiles, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    validateCommitHash(args.commitHash, 'commitHash');
    return getCommitChangedFiles(args.worktreePath, args.commitHash);
  });
  ipcMain.handle(IPC.GetCommitDiffs, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    validateCommitHash(args.commitHash, 'commitHash');
    return getCommitDiffs(args.worktreePath, args.commitHash);
  });
  ipcMain.handle(IPC.GetCoverageSummary, (_e, args) => {
    validatePath(args.repoRoot, 'repoRoot');
    assertOptionalString(args.reportPath, 'reportPath');
    const reportPath = args.reportPath?.trim() || undefined;
    if (reportPath) validateRelativePath(reportPath, 'reportPath');
    return readCoverageSummary(args.repoRoot, reportPath);
  });
  ipcMain.handle(IPC.PushTask, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    validateBranchName(args.branchName, 'branchName');
    assertString(args.onOutput?.__CHANNEL_ID__, 'channelId');
    return pushTask(win, args.projectRoot, args.branchName, args.onOutput.__CHANNEL_ID__);
  });
  ipcMain.handle(IPC.RebaseTask, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    const baseBranch = args.baseBranch || undefined;
    if (baseBranch) validateBranchName(baseBranch, 'baseBranch');
    return rebaseTask(args.worktreePath, baseBranch);
  });
  ipcMain.handle(IPC.GetMainBranch, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    return getMainBranch(args.projectRoot);
  });
  ipcMain.handle(IPC.GetCurrentBranch, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    return getCurrentBranch(args.projectRoot);
  });
  ipcMain.handle(IPC.CheckoutBranch, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    validateBranchName(args.branchName, 'branchName');
    return checkoutBranch(args.projectRoot, args.branchName);
  });
  ipcMain.handle(IPC.CheckIsGitRepo, (_e, args) => {
    validatePath(args.path, 'path');
    return isGitRepo(args.path);
  });
  ipcMain.handle(IPC.GetBranches, (_e, args) => {
    validatePath(args.projectRoot, 'projectRoot');
    return getBranches(args.projectRoot);
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
    } catch (e) {
      console.warn('Ignoring malformed saved state:', e);
    }
  }
  ipcMain.handle(IPC.SaveAppState, (_e, args) => {
    assertString(args.json, 'json');
    syncTaskNamesFromJson(args.json);
    return saveAppState(args.json);
  });
  ipcMain.handle(IPC.LoadAppState, () => {
    const json = loadAppState();
    if (json) syncTaskNamesFromJson(json);
    return json;
  });

  // --- Keybindings ---
  function getKeybindingsDir(): string {
    let dir = app.getPath('userData');
    if (!app.isPackaged) {
      const base = path.basename(dir);
      dir = path.join(path.dirname(dir), `${base}-dev`);
    }
    return dir;
  }

  ipcMain.handle(IPC.LoadKeybindings, () => {
    return loadKeybindings(getKeybindingsDir());
  });

  ipcMain.handle(IPC.SaveKeybindings, (_e, args) => {
    assertString(args?.json, 'json');
    saveKeybindings(getKeybindingsDir(), args.json);
  });

  // --- Arena persistence ---
  ipcMain.handle(IPC.SaveArenaData, (_e, args) => {
    assertString(args.filename, 'filename');
    assertString(args.json, 'json');
    const filePath = path.join(app.getPath('userData'), args.filename);
    const basename = path.basename(filePath);
    if (basename !== args.filename) throw new Error('Invalid filename');
    if (!basename.startsWith('arena-') || !basename.endsWith('.json'))
      throw new Error('Arena files must be arena-*.json');
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, args.json, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  });

  ipcMain.handle(IPC.LoadArenaData, (_e, args) => {
    assertString(args.filename, 'filename');
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
    return createWorktree(
      args.projectRoot,
      args.branchName,
      args.symlinkDirs ?? [],
      undefined,
      true,
    );
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

  // --- Plan watcher cleanup ---
  ipcMain.handle(IPC.StopPlanWatcher, (_e, args) => {
    assertString(args.taskId, 'taskId');
    stopPlanWatcher(args.taskId);
  });

  // --- Plan content (one-shot read) ---
  ipcMain.handle(IPC.ReadPlanContent, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    const fileName = typeof args.fileName === 'string' ? args.fileName : undefined;
    if (fileName) validateRelativePath(fileName, 'fileName');
    return readPlanForWorktree(args.worktreePath, fileName);
  });

  // --- Steps watcher cleanup ---
  ipcMain.handle(IPC.StopStepsWatcher, (_e, args) => {
    assertString(args.taskId, 'taskId');
    stopStepsWatcher(args.taskId);
  });

  // --- PR CI status watcher ---
  initPrChecks(win);
  ipcMain.handle(IPC.StartPrChecksWatcher, (_e, args) => {
    assertString(args.taskId, 'taskId');
    assertString(args.prUrl, 'prUrl');
    assertString(args.taskName, 'taskName');
    if (!isPrUrl(args.prUrl)) return; // defense in depth — also re-checked downstream
    startPrChecksWatcher({
      taskId: args.taskId,
      prUrl: args.prUrl,
      taskName: args.taskName,
    });
  });
  ipcMain.handle(IPC.StopPrChecksWatcher, (_e, args) => {
    assertString(args.taskId, 'taskId');
    stopPrChecksWatcher(args.taskId);
  });

  // --- Steps content (one-shot read) ---
  ipcMain.handle(IPC.ReadStepsContent, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    return readStepsForWorktree(args.worktreePath);
  });

  // --- Ask about code ---
  ipcMain.handle(IPC.SetMinimaxApiKey, (_e, args) => {
    assertString(args.key, 'key');
    setMinimaxApiKey(args.key);
  });

  ipcMain.handle(IPC.AskAboutCode, (_e, args) => {
    assertString(args.requestId, 'requestId');
    assertString(args.prompt, 'prompt');
    assertString(args.onOutput?.__CHANNEL_ID__, 'channelId');
    validatePath(args.cwd, 'cwd');
    const provider: string | undefined =
      typeof args.provider === 'string' ? args.provider : undefined;
    askAboutCode(win, {
      requestId: args.requestId,
      channelId: args.onOutput.__CHANNEL_ID__,
      prompt: args.prompt,
      cwd: args.cwd,
      provider: provider === 'minimax' ? 'minimax' : 'claude',
    });
  });

  ipcMain.handle(IPC.CancelAskAboutCode, (_e, args) => {
    assertString(args.requestId, 'requestId');
    cancelAskAboutCode(args.requestId);
  });

  // --- File links ---
  ipcMain.handle(IPC.OpenPath, (_e, args) => {
    validatePath(args.filePath, 'filePath');
    // Block executable extensions to prevent accidental code execution
    const dangerous = /\.(sh|bash|exe|bat|cmd|app|command|desktop|appimage|run)$/i;
    if (dangerous.test(args.filePath)) {
      throw new Error('Cannot open executable files');
    }
    return shell.openPath(args.filePath);
  });

  ipcMain.handle(IPC.ReadFileText, async (_e, args) => {
    validatePath(args.filePath, 'filePath');
    if (!/\.md$/i.test(args.filePath)) {
      throw new Error('Only .md files can be read');
    }
    const stat = await fs.promises.stat(args.filePath);
    if (stat.size > 2 * 1024 * 1024) {
      throw new Error('File too large to preview (max 2 MB)');
    }
    return fs.promises.readFile(args.filePath, 'utf8');
  });

  // --- Clipboard ---
  const clipboardImagePath = path.join(os.tmpdir(), 'parallel-code-clipboard.png');
  ipcMain.handle(IPC.SaveClipboardImage, async () => {
    try {
      const img = clipboard.readImage();
      if (img.isEmpty()) return null;
      const buf = img.toPNG();
      await fs.promises.writeFile(clipboardImagePath, buf);
      return clipboardImagePath;
    } catch (e) {
      console.error('[clipboard] Failed to save clipboard image:', e);
      return null;
    }
  });

  // --- System ---
  ipcMain.handle(IPC.GetSystemFonts, () => getSystemMonospaceFonts());

  // --- Notifications (fire-and-forget via ipcMain.on) ---
  const activeNotifications = new Set<Notification>();
  ipcMain.on(IPC.ShowNotification, (_e, args) => {
    try {
      if (!Notification.isSupported()) return;
      assertString(args.title, 'title');
      assertString(args.body, 'body');
      assertStringArray(args.taskIds, 'taskIds');
      const notification = new Notification({
        title: args.title,
        body: args.body,
      });
      activeNotifications.add(notification);
      const release = () => activeNotifications.delete(notification);
      notification.on('click', () => {
        release();
        if (!win.isDestroyed()) {
          win.show();
          win.focus();
          win.webContents.send(IPC.NotificationClicked, { taskIds: args.taskIds });
        }
      });
      notification.on('close', release);
      notification.show();
      // On Linux, notifications may not auto-dismiss. Close after 30 seconds
      // to prevent accumulation in the notification tray.
      if (process.platform === 'linux') {
        setTimeout(() => {
          notification.close();
          release();
        }, 30_000);
      }
    } catch (err) {
      console.warn('ShowNotification failed:', err);
    }
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
  ipcMain.handle(IPC.WindowSetSize, (_e, args) => {
    assertInt(args.width, 'width');
    assertInt(args.height, 'height');
    return win.setSize(args.width, args.height);
  });
  ipcMain.handle(IPC.WindowSetPosition, (_e, args) => {
    assertInt(args.x, 'x');
    assertInt(args.y, 'y');
    return win.setPosition(args.x, args.y);
  });
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

  ipcMain.handle(IPC.ShellOpenInEditor, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    if (typeof args.editorCommand !== 'string' || !args.editorCommand.trim()) {
      throw new Error('editorCommand must be a non-empty string');
    }
    const cmd = args.editorCommand.trim();
    if (/[;&|`$(){}[\]<>\\'"*?!#~]/.test(cmd)) {
      throw new Error('editorCommand must not contain shell metacharacters');
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const child = spawn(cmd, [args.worktreePath], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Failed to launch "${cmd}": ${err.message}`));
        }
      });
      child.on('spawn', () => {
        if (!settled) {
          settled = true;
          child.unref();
          resolve();
        }
      });
    });
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
      orchestrator,
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

  // --- MCP server management ---
  ipcMain.handle(
    IPC.StartMCPServer,
    async (
      _e,
      args: {
        coordinatorTaskId: string;
        projectId: string;
        projectRoot: string;
        worktreePath?: string;
      },
    ) => {
      // Set orchestrator's default project + coordinator task ID
      orchestrator.setDefaultProject(args.projectId, args.projectRoot, args.coordinatorTaskId);

      // Start remote server if not running
      if (!remoteServer) {
        const thisDir = path.dirname(fileURLToPath(import.meta.url));
        const distRemote = path.join(thisDir, '..', '..', 'dist-remote');
        remoteServer = startRemoteServer({
          port: 7777,
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
          orchestrator,
        });
      }

      // Write temp MCP config file — use the bundled single-file MCP server
      // (built by esbuild, no external deps needed at runtime)
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      let mcpServerPath = path.join(thisDir, '..', 'mcp-server.cjs');

      // In packaged builds, asar-unpacked files live in app.asar.unpacked/
      if (mcpServerPath.includes('/app.asar/')) {
        mcpServerPath = mcpServerPath.replace('/app.asar/', '/app.asar.unpacked/');
      }
      const serverUrl = `http://127.0.0.1:${remoteServer.port}`;

      const mcpConfig = {
        mcpServers: {
          'parallel-code': {
            type: 'stdio' as const,
            command: 'node',
            args: [mcpServerPath, '--url', serverUrl, '--token', remoteServer.token],
          },
        },
      };

      const configJson = JSON.stringify(mcpConfig, null, 2);

      // Write temp config for --mcp-config flag
      const configPath = path.join(
        app.getPath('temp'),
        `parallel-code-mcp-${args.coordinatorTaskId}.json`,
      );
      fs.writeFileSync(configPath, configJson);

      // Also write .mcp.json into the worktree so Claude Code auto-discovers it.
      // Immediately git-exclude it so the token never gets committed.
      if (args.worktreePath) {
        const worktreeMcpPath = path.join(args.worktreePath, '.mcp.json');
        fs.writeFileSync(worktreeMcpPath, configJson);

        // Append to .git/info/exclude (local-only gitignore, not committed)
        try {
          const gitDir = path.join(args.worktreePath, '.git');
          // Worktrees use a .git file pointing to the real gitdir
          let infoDir: string;
          if (fs.statSync(gitDir).isFile()) {
            const gitFileContent = fs.readFileSync(gitDir, 'utf-8').trim();
            const realGitDir = gitFileContent.replace(/^gitdir:\s*/, '');
            infoDir = path.join(
              path.isAbsolute(realGitDir)
                ? realGitDir
                : path.resolve(args.worktreePath, realGitDir),
              'info',
            );
          } else {
            infoDir = path.join(gitDir, 'info');
          }
          fs.mkdirSync(infoDir, { recursive: true });
          const excludePath = path.join(infoDir, 'exclude');
          const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf-8') : '';
          if (!existing.includes('.mcp.json')) {
            fs.appendFileSync(
              excludePath,
              '\n# Parallel Code MCP config (contains ephemeral token)\n.mcp.json\n',
            );
          }
        } catch (err) {
          console.warn('[MCP] Could not git-exclude .mcp.json:', err);
        }

        console.warn('[MCP] Worktree .mcp.json written to:', worktreeMcpPath);
      }

      console.warn('[MCP] Config written to:', configPath);
      console.warn('[MCP] Server path:', mcpServerPath);
      console.warn('[MCP] Remote URL:', serverUrl);

      return {
        configPath,
        serverUrl,
        token: remoteServer.token,
        port: remoteServer.port,
      };
    },
  );

  ipcMain.handle(IPC.StopMCPServer, async () => {
    // The MCP server process is spawned by Claude Code (via --mcp-config),
    // not by us. This handler is a no-op but kept for API completeness.
  });

  ipcMain.handle(IPC.GetMCPStatus, () => {
    // The MCP server process is spawned by Claude Code (via --mcp-config),
    // not by us. We report whether the remote HTTP server that the MCP
    // server connects to is running — if it's up, MCP tools should work.
    return {
      mcpRunning: remoteServer !== null,
      remoteRunning: remoteServer !== null,
    };
  });

  ipcMain.handle(IPC.GetMCPLogs, () => getMCPLogs());

  // --- Forward window events to renderer ---
  win.on('focus', () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.WindowFocus);
  });
  win.on('blur', () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.WindowBlur);
  });
  win.on('resize', createThrottledForwarder(win, IPC.WindowResized, 100));
  win.on('move', createThrottledForwarder(win, IPC.WindowMoved, 100));
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
