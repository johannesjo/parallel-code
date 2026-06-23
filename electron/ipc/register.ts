import { ipcMain, dialog, shell, app, clipboard, BrowserWindow, Notification } from 'electron';
import crypto from 'crypto';
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
import {
  initPrChecks,
  startPrChecksWatcher,
  stopPrChecksWatcher,
  detectPrUrlForBranch,
  refreshPrChecksWatcher,
  isPrUrl,
} from './pr-checks.js';
import { readCoverageSummary } from './coverage.js';
import { startRemoteServer, getMCPLogs } from '../remote/server.js';
import { atomicWriteFileSync } from '../mcp/atomic.js';
import { buildMcpLaunchArgs } from '../mcp/agent-args.js';
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
  getUncommittedChangedFiles,
  getUncommittedFileDiffs,
} from './git.js';
import { createTask, deleteTask } from './tasks.js';
import { listAgents } from './agents.js';
import {
  saveAppState,
  loadAppState,
  loadCustomThemeFiles,
  saveCustomThemeFile,
  deleteCustomThemeFile,
} from './persistence.js';
import { loadKeybindings, saveKeybindings } from './keybindings.js';
import {
  initAutoUpdater,
  getUpdateStatus,
  checkForUpdates,
  downloadUpdate,
  quitAndInstallUpdate,
} from './updater.js';
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
import { validateBranchName as sharedValidateBranchName, validateUUID } from '../mcp/validation.js';
import { debug as logDebug, warn as logWarn, errMessage } from '../log.js';
import { getMCPRemoteServerUrl, detectStaleDockerMCPUrl } from '../mcp/config.js';
import { redactServerUrl } from '../remote/server.js';

export function selectMcpJsonDir(worktreePath: string | undefined, projectRoot: string): string {
  return worktreePath ?? projectRoot;
}

/** Path where `mcp-server.cjs` is copied inside the Docker-mounted worktree. */
export function getDockerMcpServerDestPath(
  worktreePath: string | undefined,
  projectRoot: string,
): string {
  return path.join(worktreePath ?? projectRoot, '.parallel-code', 'mcp-server.cjs');
}

export interface CoordinatorMCPConfigOpts {
  mcpServerPath: string;
  serverUrl: string;
  token: string;
  coordinatorTaskId: string;
  skipPermissions?: boolean;
  propagateSkipPermissions?: boolean;
}

/** Builds the coordinator MCP server config used for launch args and `.mcp.json`. */
export function buildCoordinatorMCPConfig(opts: CoordinatorMCPConfigOpts): {
  mcpServers: {
    'parallel-code': {
      type: 'stdio';
      command: 'node';
      args: string[];
      env: Record<string, string>;
    };
  };
} {
  return {
    mcpServers: {
      'parallel-code': {
        type: 'stdio',
        command: 'node',
        args: [
          opts.mcpServerPath,
          '--url',
          opts.serverUrl,
          '--coordinator-id',
          opts.coordinatorTaskId,
          ...(opts.skipPermissions && opts.propagateSkipPermissions ? ['--skip-permissions'] : []),
        ],
        env: { PARALLEL_CODE_MCP_TOKEN: opts.token },
      },
    },
  };
}

async function startRemoteServerOnFreePort(
  start: number,
  end: number,
  opts: Omit<Parameters<typeof startRemoteServer>[0], 'port'>,
): Promise<Awaited<ReturnType<typeof startRemoteServer>>> {
  for (let port = start; port <= end; port++) {
    try {
      return await startRemoteServer({ ...opts, port });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && port < end) continue;
      throw err;
    }
  }
  throw new Error(`No free port found in range ${start}–${end}`);
}

/** Reject paths that are non-absolute or attempt directory traversal. */
function validatePath(p: unknown, label: string): void {
  if (typeof p !== 'string') throw new Error(`${label} must be a string`);
  if (!path.isAbsolute(p)) throw new Error(`${label} must be absolute`);
  if (p.includes('..')) throw new Error(`${label} must not contain ".."`);
}

function isMissingCommandError(err: unknown, command: string): boolean {
  const e = err as { path?: unknown; syscall?: unknown };
  return (
    e.path === command || (typeof e.syscall === 'string' && e.syscall.includes(`spawn ${command}`))
  );
}

/** Validates renderer-supplied args for StartMCPServer before any file I/O. Exported for testing. */
export function validateStartMCPServerArgs(args: Record<string, unknown>): void {
  validateUUID(args.coordinatorTaskId, 'coordinatorTaskId');
  assertString(args.projectId, 'projectId');
  validatePath(args.projectRoot, 'projectRoot');
  if (args.worktreePath !== undefined) validatePath(args.worktreePath, 'worktreePath');
  if (args.coordinatorBranch !== undefined) {
    validateBranchName(args.coordinatorBranch, 'coordinatorBranch');
  }
  if (args.agentCommand !== undefined) assertString(args.agentCommand, 'agentCommand');
  if (args.agentArgs !== undefined) assertStringArray(args.agentArgs, 'agentArgs');
  assertOptionalBoolean(args.skipPermissions, 'skipPermissions');
  assertOptionalBoolean(args.propagateSkipPermissions, 'propagateSkipPermissions');
  if (args.dockerContainerName !== undefined) {
    assertString(args.dockerContainerName, 'dockerContainerName');
    if (!/^[a-zA-Z0-9_.-]+$/.test(args.dockerContainerName as string)) {
      throw new Error('dockerContainerName contains invalid characters');
    }
  }
  if (args.dockerImage !== undefined) {
    assertString(args.dockerImage, 'dockerImage');
    if (!(args.dockerImage as string).trim()) {
      throw new Error('dockerImage must not be blank');
    }
  }
}

/** Reject relative paths that attempt directory traversal or are absolute. */
function validateRelativePath(p: unknown, label: string): void {
  if (typeof p !== 'string') throw new Error(`${label} must be a string`);
  if (path.isAbsolute(p)) throw new Error(`${label} must not be absolute`);
  if (p.includes('..')) throw new Error(`${label} must not contain ".."`);
}

export function validateExternalHttpUrl(rawUrl: unknown): string {
  assertString(rawUrl, 'url');
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('url must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url must use http or https');
  }
  return parsed.href;
}

export async function openExternalHttpUrl(
  rawUrl: unknown,
  openExternal: (url: string) => Promise<void> = shell.openExternal,
): Promise<void> {
  const url = validateExternalHttpUrl(rawUrl);
  try {
    await openExternal(url);
  } catch {
    throw new Error('Failed to open external URL');
  }
}

const validateBranchName = sharedValidateBranchName;

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

/** First file URL on the clipboard, or null if none.
 *  macOS uses `public.file-url` (one URL per call).
 *  Linux file managers vary:
 *    - Files (Nautilus), Nemo, etc. publish `x-special/gnome-copied-files`
 *      as `<verb>\nfile:///path1\nfile:///path2`, where <verb> is `copy`
 *      or `cut`. This is the dominant Linux desktop format and MUST be
 *      checked before `text/uri-list` because some apps publish both
 *      flavours and the GNOME flavour is the authoritative one.
 *    - Falls back to `text/uri-list` (newline-separated) for KDE, Xfce,
 *      and any cross-desktop publisher that follows RFC 2483. */
function readClipboardFileUrl(formats: string[]): string | null {
  if (formats.includes('public.file-url')) {
    const url = clipboard.read('public.file-url').trim();
    if (url) return url;
  }
  if (formats.includes('x-special/gnome-copied-files')) {
    const payload = clipboard.read('x-special/gnome-copied-files');
    // First line is the verb (copy/cut); subsequent lines are file URLs.
    const lines = payload.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('file://')) return trimmed;
    }
  }
  if (formats.includes('text/uri-list')) {
    const list = clipboard.read('text/uri-list');
    for (const line of list.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.startsWith('file://')) return trimmed;
    }
  }
  return null;
}

/** Convert a file:// URL to an absolute path, returning '' on failure. */
function fileUrlToPath(url: string): string {
  try {
    return fileURLToPath(url);
  } catch {
    return '';
  }
}

/** Strip path separators and clamp to a sane length so a renderer-supplied
 *  filename can't escape the temp dir. Falls back to a generic name when empty.
 *  Always appends a 6-char random suffix so two same-name drops landing in the
 *  same millisecond don't overwrite each other. */
function sanitizeDroppedName(name: string): string {
  const base = name
    // eslint-disable-next-line no-control-regex -- intentional NUL strip for filesystem safety
    .replace(/[\\/\x00]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  if (base) return `parallel-code-drop-${stamp}-${base}`;
  return `parallel-code-drop-${stamp}.png`;
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

/**
 * Append a local-only entry to a worktree's `.git/info/exclude`, idempotent on
 * `marker`. Resolves linked-worktree gitdir files (relative or absolute) and
 * creates `info/` if missing. Best-effort: never throws, since failing to
 * git-exclude a generated file must not block coordinator startup.
 */
function appendGitExclude(worktreeRoot: string, marker: string, block: string): void {
  try {
    const gitPath = path.join(worktreeRoot, '.git');
    let infoDir: string;
    if (fs.statSync(gitPath).isFile()) {
      const realGitDir = fs
        .readFileSync(gitPath, 'utf-8')
        .trim()
        .replace(/^gitdir:\s*/, '');
      infoDir = path.join(
        path.isAbsolute(realGitDir) ? realGitDir : path.resolve(worktreeRoot, realGitDir),
        'info',
      );
    } else {
      infoDir = path.join(gitPath, 'info');
    }
    fs.mkdirSync(infoDir, { recursive: true });
    const excludePath = path.join(infoDir, 'exclude');
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf-8') : '';
    if (!existing.includes(marker)) {
      fs.appendFileSync(excludePath, block);
    }
  } catch (err) {
    console.warn(`[MCP] Could not git-exclude ${marker}:`, err);
  }
}

export function registerAllHandlers(win: BrowserWindow): void {
  // --- Remote access state ---
  let remoteServer: Awaited<ReturnType<typeof startRemoteServer>> | null = null;
  const taskNames = new Map<string, string>();

  // --- MCP coordinator (lazy — only loaded when coordinator mode is enabled) ---
  type CoordinatorType = import('../mcp/coordinator.js').Coordinator;
  let coordinator: CoordinatorType | null = null;
  let coordinatorHandlersRegistered = false;
  let lastMcpConfigPath: string | null = null;
  // True when the remote server was started by StartMCPServer (not the manual StartRemoteServer).
  // Used to stop the server automatically when the last MCP coordinator deregisters.
  let remoteServerStartedForMcp = false;
  // True when the user has explicitly requested remote access via StartRemoteServer.
  // Prevents auto-stop when coordinator deregisters even if MCP started the server first.
  let remoteServerRequestedManually = false;
  // True when StopRemoteServer was called while a coordinator was active.
  // The server will be stopped when the last coordinator deregisters.
  let remoteServerPendingStop = false;

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
    assertOptionalBoolean(args.attachExisting, 'attachExisting');
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
    if (args.taskId !== undefined) {
      assertString(args.taskId, 'taskId');
      if (coordinator?.isAutomationWriteInFlight(args.taskId)) return false;
    }
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
  ipcMain.handle(IPC.GetUncommittedChangedFiles, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    return getUncommittedChangedFiles(args.worktreePath);
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
    const recentFallback =
      typeof args.recentFallback === 'number' && args.recentFallback > 0
        ? args.recentFallback
        : undefined;
    return getBranchCommits(args.worktreePath, baseBranch, recentFallback);
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
  ipcMain.handle(IPC.GetUncommittedFileDiffs, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    return getUncommittedFileDiffs(args.worktreePath);
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
      const state = JSON.parse(json) as {
        tasks?: Record<string, { id: string; name: string }>;
        coordinatorNotificationDelayMs?: unknown;
      };
      if (state.tasks) {
        for (const t of Object.values(state.tasks)) {
          if (t.id && t.name) taskNames.set(t.id, t.name);
        }
      }
      const delay = state.coordinatorNotificationDelayMs;
      if (typeof delay === 'number' && Number.isFinite(delay)) {
        coordinator?.setNotificationDelayMs(delay);
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
  ipcMain.handle(IPC.LoadCustomThemes, () => loadCustomThemeFiles());
  ipcMain.handle(IPC.SaveCustomTheme, (_e, args) => {
    assertString(args.id, 'id');
    assertString(args.css, 'css');
    if (!/^[a-zA-Z0-9_-]+$/.test(args.id)) throw new Error('Invalid theme id');
    saveCustomThemeFile(args.id, args.css);
  });
  ipcMain.handle(IPC.DeleteCustomTheme, (_e, args) => {
    assertString(args.id, 'id');
    if (!/^[a-zA-Z0-9_-]+$/.test(args.id)) throw new Error('Invalid theme id');
    deleteCustomThemeFile(args.id);
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
  ipcMain.handle(IPC.DetectPrForBranch, (_e, args) => {
    validatePath(args.worktreePath, 'worktreePath');
    validateBranchName(args.branchName, 'branchName');
    return detectPrUrlForBranch(args.worktreePath, args.branchName)
      .then((url) => ({ url }))
      .catch((err: unknown) => {
        const code = (err as NodeJS.ErrnoException)?.code;
        const stderr = (err as { stderr?: string })?.stderr ?? '';
        if (code === 'ENOENT' && isMissingCommandError(err, 'gh')) {
          return { url: null, unavailable: 'missing' };
        }
        if (code === 'ENOENT') return { url: null };
        if (/not logged into|authentication required/i.test(stderr)) {
          return { url: null, unavailable: 'auth' };
        }
        console.warn('[pr-checks] branch PR detection failed:', (err as Error)?.message ?? err);
        return { url: null };
      });
  });
  ipcMain.handle(IPC.RefreshPrChecksWatcher, (_e, args) => {
    assertString(args.taskId, 'taskId');
    refreshPrChecksWatcher(args.taskId);
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

  // Resolve the most useful representation of the current clipboard contents
  // for pasting into a terminal. Order of preference:
  //   1. file references (Finder copy, Nautilus copy, etc.) → return absolute path
  //   2. raster image (screenshot, image-app copy)         → save PNG to tmp + return path
  //   3. plain text                                        → return as-is
  //
  // Without (1), copying an image file from Finder gives only the basename via
  // navigator.clipboard.readText(), which is useless to a CLI agent that needs a
  // path it can stat. macOS exposes file copies via the 'public.file-url' format,
  // Linux via 'text/uri-list'. Windows is not a published target.
  ipcMain.handle(IPC.ResolveClipboardPaste, async () => {
    try {
      const formats = clipboard.availableFormats();
      const fileUrl = readClipboardFileUrl(formats);
      if (fileUrl) {
        const filePath = fileUrlToPath(fileUrl);
        if (filePath) return { kind: 'file', path: filePath };
      }
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        const buf = img.toPNG();
        await fs.promises.writeFile(clipboardImagePath, buf);
        return { kind: 'image', path: clipboardImagePath };
      }
      const text = clipboard.readText();
      if (text) return { kind: 'text', text };
      return { kind: 'empty' };
    } catch (e) {
      console.error('[clipboard] resolveClipboardPaste failed:', e);
      return { kind: 'empty' };
    }
  });

  // Save image bytes that were dropped from a source without a filesystem path
  // (e.g. <img> dragged from a browser). The renderer reads the dropped File as
  // an ArrayBuffer, base64-encodes it, and forwards it here so the CLI agent
  // can read the result. We require base64 (not Uint8Array / ArrayBuffer)
  // because the renderer's invoke() wrapper does a JSON.parse(JSON.stringify(args))
  // round-trip that destroys typed arrays.
  ipcMain.handle(IPC.SaveDroppedImage, async (_e, args) => {
    if (!args || typeof args !== 'object') throw new Error('invalid args');
    const { name, data } = args as { name?: unknown; data?: unknown };
    if (typeof data !== 'string') throw new Error('data must be a base64 string');
    const buf = Buffer.from(data, 'base64');
    const safeName = sanitizeDroppedName(typeof name === 'string' ? name : '');
    const filePath = path.join(os.tmpdir(), safeName);
    await fs.promises.writeFile(filePath, buf);
    return filePath;
  });

  // --- System ---
  ipcMain.handle(IPC.GetSystemFonts, () => getSystemMonospaceFonts());

  // --- Auto-update ---
  initAutoUpdater(win);
  ipcMain.handle(IPC.GetUpdateStatus, () => getUpdateStatus());
  ipcMain.handle(IPC.CheckForUpdates, () => checkForUpdates());
  ipcMain.handle(IPC.DownloadUpdate, () => downloadUpdate());
  ipcMain.handle(IPC.QuitAndInstallUpdate, () => quitAndInstallUpdate());

  // --- Notifications (fire-and-forget via ipcMain.on) ---
  const activeNotifications = new Set<Notification>();
  ipcMain.handle(IPC.ShowNotification, (_e, args) => {
    try {
      assertString(args.title, 'title');
      assertString(args.body, 'body');
      assertStringArray(args.taskIds, 'taskIds');
      const ctx = { title: args.title, body: args.body, taskIds: args.taskIds };
      const warnCtx = { taskIds: args.taskIds };
      logDebug('notification', 'show requested', ctx);
      if (!Notification.isSupported()) {
        logWarn('notification', 'native notifications are not supported', warnCtx);
        return { ok: false, reason: 'unsupported' };
      }
      const notification = new Notification({
        title: args.title,
        body: args.body,
      });
      activeNotifications.add(notification);
      const release = () => activeNotifications.delete(notification);
      notification.on('show', () => {
        logDebug('notification', 'show event', ctx);
      });
      notification.on('failed', (_event, error) => {
        release();
        logWarn('notification', 'show failed', { ...warnCtx, err: error });
        // Surface the failure to the renderer so the UI can inform the user.
        // NOTE: The `failed` event only fires on macOS starting in Electron 42
        // (UNNotification migration). On Electron 40 (current), this code path
        // is macOS-inert — it still fires on Windows. Once the project upgrades
        // past Electron 42, this will activate for unsigned macOS builds too.
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.NotificationFailed, {
            error: typeof error === 'string' ? error : String(error),
            platform: process.platform,
          });
        }
      });
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
      logDebug('notification', 'show invoked', ctx);
      // On Linux, notifications may not auto-dismiss. Close after 30 seconds
      // to prevent accumulation in the notification tray.
      if (process.platform === 'linux') {
        setTimeout(() => {
          notification.close();
          release();
        }, 30_000);
      }
      return { ok: true, reason: 'show_invoked' };
    } catch (err) {
      logWarn('notification', 'show request failed', { err: errMessage(err) });
      return { ok: false, reason: 'error', err: errMessage(err) };
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

  ipcMain.handle(IPC.DialogChoice, async (_e, args) => {
    const result = await dialog.showMessageBox(win, {
      type: args.kind === 'warning' ? 'warning' : 'question',
      title: args.title || 'Confirm',
      message: args.message,
      buttons: args.buttons,
      defaultId: args.defaultId ?? 0,
      cancelId: args.cancelId ?? args.buttons.length - 1,
    });
    return result.response;
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

  ipcMain.handle(IPC.ShellOpenExternal, async (_e, args) => {
    await openExternalHttpUrl(args.url);
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
  ipcMain.handle(IPC.StartRemoteServer, async (_e, args: { port?: number }) => {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const distRemote = path.join(thisDir, '..', '..', 'dist-remote');
    const remoteServerOpts = {
      host: '0.0.0.0' as const,
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
      getCoordinator: () => coordinator,
    };

    if (remoteServer) {
      // If server was started for MCP-only (loopback), rebind to 0.0.0.0 so WiFi/Tailscale
      // clients can reach it. Skip rebind while a coordinator is active — restarting the
      // server would break ongoing MCP connections.
      if (remoteServerStartedForMcp && !coordinator?.hasActiveCoordinator()) {
        const prevPort = remoteServer.port;
        await remoteServer.stop();
        remoteServer = null;
        remoteServerStartedForMcp = false;
        remoteServer = await startRemoteServer({
          port: args.port ?? prevPort,
          ...remoteServerOpts,
        });
      }
      // Loopback-only means the server is MCP-only and inaccessible from other devices.
      // Return unavailableReason without marking this as a successful manual start.
      if (remoteServer.bindHost === '127.0.0.1') {
        return {
          url: remoteServer.url,
          wifiUrl: null,
          tailscaleUrl: null,
          port: remoteServer.port,
          unavailableReason: 'coordinator_active' as const,
        };
      }
      remoteServerRequestedManually = true;
      remoteServerPendingStop = false;
      return {
        url: remoteServer.url,
        wifiUrl: remoteServer.wifiUrl,
        tailscaleUrl: remoteServer.tailscaleUrl,
        port: remoteServer.port,
      };
    }

    // Remote access is an explicit user action — bind to all interfaces so WiFi/Tailscale clients
    // can reach the SPA. Coordinator MCP-only mode uses 127.0.0.1 by default.
    remoteServer = await startRemoteServer({ port: args.port ?? 7777, ...remoteServerOpts });
    remoteServerRequestedManually = true;
    remoteServerPendingStop = false;
    return {
      url: remoteServer.url,
      wifiUrl: remoteServer.wifiUrl,
      tailscaleUrl: remoteServer.tailscaleUrl,
      port: remoteServer.port,
    };
  });

  ipcMain.handle(IPC.StopRemoteServer, async (): Promise<{ stopped: boolean; reason?: string }> => {
    if (!remoteServer) return { stopped: true };
    if (coordinator?.hasActiveCoordinator()) {
      // The coordinator MCP transport shares this HTTP server. Stopping it while
      // a coordinator is active would break all in-flight MCP tool calls.
      // Record the pending stop so the last coordinator deregistration will auto-stop.
      remoteServerPendingStop = true;
      console.warn(
        '[Remote] Stop requested but coordinator MCP is active — will stop on last coordinator exit',
      );
      return { stopped: false, reason: 'coordinator_active' };
    }
    await remoteServer.stop();
    remoteServer = null;
    remoteServerRequestedManually = false;
    return { stopped: true };
  });

  ipcMain.handle(IPC.GetRemoteStatus, () => {
    if (!remoteServer || remoteServer.bindHost === '127.0.0.1') {
      return { enabled: false, connectedClients: 0 };
    }
    return {
      enabled: true,
      connectedClients: remoteServer.connectedClients(),
      url: remoteServer.url,
      wifiUrl: remoteServer.wifiUrl,
      tailscaleUrl: remoteServer.tailscaleUrl,
      port: remoteServer.port,
    };
  });

  // --- MCP server management ---

  // Registers coordinator-specific IPC handlers. Called lazily when coordinator
  // mode is enabled (either at startup from persisted state, or on first toggle).
  function registerCoordinatorHandlers(): void {
    if (coordinatorHandlersRegistered) return;
    coordinatorHandlersRegistered = true;

    // NOTE: StartMCPServer is registered eagerly (below, outside this function) so the
    // renderer can call it during restore before enableCoordinatorMode() completes.

    ipcMain.handle(
      IPC.MCP_ControlChanged,
      (_e, args: { taskId: string; controlledBy: 'coordinator' | 'human' }) => {
        assertString(args.taskId, 'taskId');
        if (args.controlledBy !== 'coordinator' && args.controlledBy !== 'human') {
          throw new Error(`Invalid controlledBy: ${String(args.controlledBy)}`);
        }
        if (!coordinator) throw new Error('coordinator mode not initialized');
        coordinator.setTaskControl(args.taskId, args.controlledBy);
      },
    );

    ipcMain.handle(
      IPC.MCP_CoordinatorRegistered,
      (
        _e,
        args: {
          coordinatorTaskId: string;
          projectId: string;
          coordinatorBranch?: string;
          worktreePath?: string;
        },
      ) => {
        assertString(args.coordinatorTaskId, 'coordinatorTaskId');
        assertString(args.projectId, 'projectId');
        if (args.coordinatorBranch !== undefined) {
          validateBranchName(args.coordinatorBranch, 'coordinatorBranch');
        }
        coordinator?.registerCoordinator(args.coordinatorTaskId, args.projectId, {
          branchName: args.coordinatorBranch,
          worktreePath: args.worktreePath,
        });
      },
    );

    ipcMain.handle(
      IPC.MCP_CoordinatorDeregistered,
      async (_e, args: { coordinatorTaskId: string }) => {
        assertString(args.coordinatorTaskId, 'coordinatorTaskId');
        coordinator?.deregisterCoordinator(args.coordinatorTaskId);
        // Clean up the host-temp MCP config file written by StartMCPServer (non-Docker only).
        const tempConfigPath = path.join(
          app.getPath('temp'),
          `parallel-code-mcp-${args.coordinatorTaskId}.json`,
        );
        try {
          fs.unlinkSync(tempConfigPath);
        } catch {
          /* file may not exist in Docker mode or after prior cleanup */
        }
        // Stop the remote server when the last coordinator exits if:
        // - MCP started the server and user hasn't separately requested manual access, OR
        // - the user explicitly requested stop while coordinator was active (pendingStop)
        if (
          remoteServer &&
          !coordinator?.hasActiveCoordinator() &&
          (remoteServerPendingStop || (remoteServerStartedForMcp && !remoteServerRequestedManually))
        ) {
          await remoteServer.stop();
          remoteServer = null;
          remoteServerStartedForMcp = false;
          remoteServerRequestedManually = false;
          remoteServerPendingStop = false;
        }
      },
    );

    // Autofire miss threshold reached — renderer already cleared the staged notification locally.
    // Ack the batch on the backend and mark affected sub-tasks as needsReview.
    ipcMain.handle(
      IPC.MCP_CoordinatorNotificationDropAck,
      (_e, args: { coordinatorTaskId: string; batchId: string }) => {
        assertString(args.coordinatorTaskId, 'coordinatorTaskId');
        assertString(args.batchId, 'batchId');
        coordinator?.dropNotification(args.coordinatorTaskId, args.batchId);
      },
    );

    ipcMain.handle(IPC.MCP_CoordinatedTaskPromptDelivered, (_e, args: { taskId: string }) => {
      assertString(args.taskId, 'taskId');
      coordinator?.markPromptDelivered(args.taskId);
    });

    ipcMain.handle(
      IPC.MCP_CoordinatorNotificationAck,
      (_e, args: { coordinatorTaskId: string; batchId: string }) => {
        assertString(args.coordinatorTaskId, 'coordinatorTaskId');
        assertString(args.batchId, 'batchId');
        coordinator?.ackNotification(args.coordinatorTaskId, args.batchId);
      },
    );

    ipcMain.handle(
      IPC.MCP_CoordinatorRestageAfterUserSend,
      (_e, args: { coordinatorTaskId: string }) => {
        assertString(args.coordinatorTaskId, 'coordinatorTaskId');
        coordinator?.rescheduleRestageTimer(args.coordinatorTaskId);
      },
    );

    ipcMain.handle(IPC.MCP_TaskLandingReviewCleared, (_e, args: { taskId: string }) => {
      assertString(args.taskId, 'taskId');
      coordinator?.markTaskReviewed(args.taskId);
    });

    ipcMain.handle(
      IPC.MCP_CoordinatedTaskClosed,
      (_e, args: { taskId: string; coordinatorTaskId: string }) => {
        assertString(args.taskId, 'taskId');
        assertString(args.coordinatorTaskId, 'coordinatorTaskId');
        coordinator?.removeCoordinatedTask(args.taskId);
      },
    );

    ipcMain.handle(
      IPC.MCP_HydrateCoordinatedTask,
      (
        _e,
        args: {
          id: string;
          name: string;
          projectId: string;
          projectRoot: string;
          branchName: string;
          baseBranch?: string;
          worktreePath: string;
          coordinatorTaskId: string;
          controlledBy?: 'coordinator' | 'human';
          agentId?: string;
          signalDoneAt?: string;
          signalDoneConsumed?: boolean;
          verification?: import('../mcp/types.js').SubtaskVerification;
          landingState?: import('../mcp/types.js').LandingState;
          landingReason?: string;
          landingSummary?: string;
          landedMetadata?: import('../mcp/types.js').LandedMetadata;
          mcpConfigPath?: string;
          agentCommand?: string;
          preambleFileExistedBefore?: boolean;
          initialPrompt?: string;
        },
      ) => {
        assertString(args.id, 'id');
        validateUUID(args.id, 'id');
        assertString(args.name, 'name');
        assertString(args.projectId, 'projectId');
        validatePath(args.projectRoot, 'projectRoot');
        assertString(args.branchName, 'branchName');
        sharedValidateBranchName(args.branchName, 'branchName');
        if (args.baseBranch !== undefined) sharedValidateBranchName(args.baseBranch, 'baseBranch');
        validatePath(args.worktreePath, 'worktreePath');
        assertString(args.coordinatorTaskId, 'coordinatorTaskId');
        validateUUID(args.coordinatorTaskId, 'coordinatorTaskId');
        if (!coordinator) throw new Error('coordinator mode not initialized');
        if (args.agentCommand !== undefined) assertString(args.agentCommand, 'agentCommand');
        if (args.initialPrompt !== undefined) assertString(args.initialPrompt, 'initialPrompt');
        const result = coordinator.hydrateTask({
          id: args.id,
          name: args.name,
          projectId: args.projectId,
          projectRoot: args.projectRoot,
          branchName: args.branchName,
          baseBranch: args.baseBranch,
          worktreePath: args.worktreePath,
          agentId: args.agentId ?? crypto.randomUUID(),
          coordinatorTaskId: args.coordinatorTaskId,
          controlledBy: args.controlledBy,
          signalDoneAt: args.signalDoneAt,
          signalDoneConsumed: args.signalDoneConsumed,
          verification: args.verification,
          landingState: args.landingState,
          landingReason: args.landingReason,
          landingSummary: args.landingSummary,
          landedMetadata: args.landedMetadata,
          mcpConfigPath: args.mcpConfigPath,
          agentCommand: args.agentCommand,
          preambleFileExistedBefore: args.preambleFileExistedBefore,
          initialPrompt: args.initialPrompt,
        });
        // Signal to renderer that MCP hydration is complete — gates TerminalView auto-spawn.
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.MCP_TaskHydrated, { taskId: args.id });
        }
        return result;
      },
    );
  }

  // Enable coordinator mode: lazily import the Coordinator module and register handlers.
  // Safe to call multiple times — only initializes once.
  async function enableCoordinatorMode(): Promise<void> {
    if (coordinator) return;
    const { Coordinator } = await import('../mcp/coordinator.js');
    coordinator = new Coordinator();
    coordinator.setWindow(win);
    registerCoordinatorHandlers();
  }

  // Renderer calls this at startup (if coordinator mode was previously enabled)
  // and when the user toggles the setting on.
  ipcMain.handle(IPC.SetCoordinatorModeEnabled, async (_e, args: { enabled: boolean }) => {
    if (args.enabled) await enableCoordinatorMode();
  });

  // Eagerly initialize if coordinator mode was enabled in the last saved state,
  // so the handlers are ready before the renderer finishes loading.
  (() => {
    const json = loadAppState();
    if (!json) return;
    try {
      const state = JSON.parse(json) as { coordinatorModeEnabled?: boolean };
      if (state.coordinatorModeEnabled === true) {
        void enableCoordinatorMode();
      }
    } catch {
      // ignore malformed state
    }
  })();

  // StartMCPServer registered eagerly (not inside registerCoordinatorHandlers) so the
  // renderer can call it during app-restore before enableCoordinatorMode() resolves.
  ipcMain.handle(
    IPC.StartMCPServer,
    async (
      _e,
      args: {
        coordinatorTaskId: string;
        projectId: string;
        projectRoot: string;
        coordinatorBranch?: string;
        worktreePath?: string;
        skipPermissions?: boolean;
        propagateSkipPermissions?: boolean;
        agentCommand?: string;
        agentArgs?: string[];
        dockerContainerName?: string;
        dockerImage?: string;
      },
    ) => {
      validateStartMCPServerArgs(args as unknown as Record<string, unknown>);

      // Fail fast on malformed .mcp.json BEFORE any coordinator state mutations.
      // Only the read/parse happens here; the merge step (which needs mcpConfig) runs later.
      const mcpJsonDir = selectMcpJsonDir(args.worktreePath, args.projectRoot);
      let worktreeMcpPath: string | undefined;
      let mcpFileExistedBefore = false;
      let existingMcpContent: Record<string, unknown> = {};
      if (mcpJsonDir) {
        worktreeMcpPath = path.join(mcpJsonDir, '.mcp.json');
        mcpFileExistedBefore = fs.existsSync(worktreeMcpPath);
        if (mcpFileExistedBefore) {
          let rawContent: string;
          try {
            rawContent = fs.readFileSync(worktreeMcpPath, 'utf-8');
          } catch (e) {
            throw new Error(`Failed to read ${worktreeMcpPath}: ${String(e)}`);
          }
          try {
            existingMcpContent = JSON.parse(rawContent) as Record<string, unknown>;
          } catch {
            throw new Error(
              `${worktreeMcpPath} contains invalid JSON — fix or remove it before starting the coordinator`,
            );
          }
        }
      }

      await enableCoordinatorMode();
      if (!coordinator) return;

      // Set coordinator's default project + coordinator task ID, and register this coordinator
      // so create_task / list_tasks know about it. Idempotent — safe to call on restore.
      coordinator.setDefaultProject(args.projectId, args.projectRoot, args.coordinatorTaskId);
      coordinator.registerCoordinator(args.coordinatorTaskId, args.projectId, {
        branchName: args.coordinatorBranch,
        worktreePath: args.worktreePath,
        skipPermissions: Boolean(args.skipPermissions && args.propagateSkipPermissions),
      });

      // Start remote server if not running
      if (!remoteServer) {
        const thisDir = path.dirname(fileURLToPath(import.meta.url));
        const distRemote = path.join(thisDir, '..', '..', 'dist-remote');
        // Docker mode on macOS requires 0.0.0.0: sub-task containers connect via
        // host.docker.internal which routes through Docker Desktop's virtual network adapter,
        // so the host must listen on all interfaces.  On Linux, --network host puts containers
        // in the host's own network namespace, so 127.0.0.1 reaches the host loopback directly.
        const isLinux = process.platform === 'linux';
        const bindHost = args.dockerContainerName && !isLinux ? '0.0.0.0' : '127.0.0.1';
        if (args.dockerContainerName && !isLinux) {
          console.warn(
            '[MCP] Docker mode (macOS): coordinator MCP server bound to 0.0.0.0 — reachable from ' +
              'local network interfaces. Traffic from sub-task containers uses Docker Desktop internal ' +
              'networking and does not traverse the physical LAN, but the port is reachable from other ' +
              'LAN hosts. Access is token-protected. Consider firewall rules on untrusted networks.',
          );
        }
        remoteServer = await startRemoteServerOnFreePort(7777, 7800, {
          host: bindHost,
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
          getCoordinator: () => coordinator,
        });
        remoteServerStartedForMcp = true;
      }

      // Resolve the source MCP server binary path.
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      let hostMcpServerPath = path.join(thisDir, '..', 'mcp-server.cjs');
      if (hostMcpServerPath.includes('/app.asar/')) {
        hostMcpServerPath = hostMcpServerPath.replace('/app.asar/', '/app.asar.unpacked/');
      }

      // In Docker mode the server is copied into the worktree so the container can reach it.
      // Compute the destination path now (pure, no side effects) so we can build mcpConfig
      // and mergedMcpJson before committing any Docker filesystem writes.
      const dockerMcpServerPath = args.dockerContainerName
        ? getDockerMcpServerDestPath(args.worktreePath, args.projectRoot)
        : undefined;
      const mcpServerPath = dockerMcpServerPath ?? hostMcpServerPath;

      const serverUrl = getMCPRemoteServerUrl(remoteServer.port, args.dockerContainerName);

      // Build mcpConfig and mergedMcpJson (pure computation — no filesystem or state side effects).
      // Doing this before any Docker copy or coordinator mutation ensures that if .mcp.json
      // merge logic ever grows fallible, Docker residue is never left behind.
      const mcpConfig = {
        mcpServers: {
          'parallel-code': {
            type: 'stdio' as const,
            command: 'node',
            args: [
              mcpServerPath,
              '--url',
              serverUrl,
              '--coordinator-id',
              args.coordinatorTaskId,
              ...(args.skipPermissions && args.propagateSkipPermissions
                ? ['--skip-permissions']
                : []),
            ],
            env: { PARALLEL_CODE_MCP_TOKEN: remoteServer.token },
          },
        },
      };

      const configJson = JSON.stringify(mcpConfig, null, 2);

      // Merge mcpConfig into the pre-validated existingMcpContent (parsed above,
      // before any coordinator state was mutated).
      // Capture the previous parallel-code entry so deregistration can restore it instead of
      // unconditionally deleting it (which would remove a user-owned entry).
      const existingServers =
        (existingMcpContent.mcpServers as Record<string, unknown> | undefined) ?? {};
      const previousMcpParallelCode: unknown = existingServers['parallel-code'];
      let mergedMcpJson: string | undefined;
      if (mcpJsonDir && worktreeMcpPath) {
        existingMcpContent.mcpServers = { ...existingServers, ...mcpConfig.mcpServers };
        mergedMcpJson = JSON.stringify(existingMcpContent, null, 2);
      }

      // All pure computation done. Now commit side effects: coordinator state mutations,
      // Docker filesystem writes, MCP config file writes.
      if (dockerMcpServerPath) {
        fs.mkdirSync(path.dirname(dockerMcpServerPath), { recursive: true });
        fs.copyFileSync(hostMcpServerPath, dockerMcpServerPath); // nosemgrep: semgrep.copyfilesync-side-effect -- all pure computation (mcpConfig, mergedMcpJson) is done above; this is correctly ordered
        coordinator.setDockerContainerName(args.coordinatorTaskId, args.dockerContainerName ?? '');
        coordinator.setDockerImage(args.coordinatorTaskId, args.dockerImage ?? null);
        console.warn('[MCP] Docker mode: copied MCP server to', dockerMcpServerPath);
        // Keep .parallel-code/ out of git status in the sub-task worktree.
        // Use .git/info/exclude (local-only, never committed) to avoid dirtying
        // a tracked .gitignore file on every Docker coordinator startup.
        appendGitExclude(
          args.worktreePath ?? args.projectRoot,
          '.parallel-code/',
          '\n# Parallel Code Docker MCP dir\n.parallel-code/\n',
        );
      } else {
        coordinator.setDockerContainerName(args.coordinatorTaskId, null);
      }

      coordinator.setMCPServerInfo(
        args.coordinatorTaskId,
        serverUrl,
        remoteServer.token,
        remoteServer.subtaskToken,
        mcpServerPath,
      );
      coordinator.setCoordinatorSpawnDefaults(
        args.coordinatorTaskId,
        args.agentCommand ?? 'claude',
        args.agentArgs ?? [],
      );

      // In docker mode the coordinator agent auto-discovers .mcp.json in the project root.
      // No host-temp configPath needed.
      let configPath: string | undefined;
      if (!args.dockerContainerName) {
        configPath = path.join(
          app.getPath('temp'),
          `parallel-code-mcp-${args.coordinatorTaskId}.json`,
        );
        atomicWriteFileSync(configPath, configJson, { mode: 0o600 });
      }

      // Write .mcp.json for auto-discovery. Read before writing — merge only the
      // parallel-code key so we don't destroy user-defined entries. Track whether
      // we created the file so deregisterCoordinator can clean up correctly.
      if (mcpJsonDir && worktreeMcpPath && mergedMcpJson !== undefined) {
        atomicWriteFileSync(worktreeMcpPath, mergedMcpJson, { mode: 0o600 });
        const writtenMcpParallelCode: unknown = mcpConfig.mcpServers['parallel-code'];
        coordinator.setMcpJsonInfo(
          args.coordinatorTaskId,
          worktreeMcpPath,
          !mcpFileExistedBefore,
          previousMcpParallelCode,
          writtenMcpParallelCode,
        );

        // Append to .git/info/exclude (local-only gitignore, not committed)
        appendGitExclude(
          mcpJsonDir,
          '.mcp.json',
          '\n# Parallel Code MCP config (contains ephemeral token)\n.mcp.json\n',
        );

        console.warn('[MCP] .mcp.json written to:', worktreeMcpPath);

        const staleWarning = detectStaleDockerMCPUrl(serverUrl, args.dockerContainerName);
        if (staleWarning) {
          logWarn('mcp', staleWarning);
          if (!win.isDestroyed()) {
            win.webContents.send(IPC.MCP_StaleUrlWarning, { message: staleWarning });
          }
        }
      }

      if (configPath) {
        lastMcpConfigPath = configPath;
        console.warn('[MCP] Config written to:', configPath);
      }
      const mcpLaunchArgs = buildMcpLaunchArgs(
        args.agentCommand ?? 'claude',
        configPath,
        mcpConfig,
      );
      console.warn('[MCP] Server path:', mcpServerPath);
      console.warn('[MCP] Remote URL:', redactServerUrl(serverUrl));

      return {
        configPath,
        mcpLaunchArgs,
        serverUrl,
        port: remoteServer.port,
      };
    },
  );

  ipcMain.handle(IPC.StopMCPServer, async () => {
    // The MCP server process is spawned by the agent CLI via launch args,
    // not by us. This handler is a no-op but kept for API completeness.
  });

  ipcMain.handle(IPC.GetMCPStatus, () => {
    // The MCP server process is spawned by the agent CLI via launch args,
    // not by us. We report whether the remote HTTP server that the MCP
    // server connects to is running — if it's up, MCP tools should work.
    return {
      running: remoteServer !== null,
      port: remoteServer?.port ?? null,
      // TODO: Surface this from the coordinator map if the UI needs it.
      coordinatorTaskId: null,
      mcpConfigPath: lastMcpConfigPath ?? null,
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
  // Fallback timer that force-destroys the window if the renderer never
  // responds to a close request (e.g. it crashed). Cleared once the renderer
  // acks that it is handling the close interactively (showing a dialog), so a
  // user deliberating over that dialog isn't force-quit out from under it.
  let forceCloseTimer: ReturnType<typeof setTimeout> | undefined;
  const clearForceCloseTimer = (): void => {
    if (forceCloseTimer) {
      clearTimeout(forceCloseTimer);
      forceCloseTimer = undefined;
    }
  };
  ipcMain.handle(IPC.WindowCloseHandling, clearForceCloseTimer);

  win.on('close', (e) => {
    e.preventDefault();
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.WindowCloseRequested);
      // Fallback: force-close if renderer doesn't respond within 5 seconds.
      // Cleared by WindowCloseHandling if the renderer takes over the close
      // interactively. If the renderer calls WindowForceClose first,
      // win.isDestroyed() will be true and this is a no-op.
      clearForceCloseTimer();
      forceCloseTimer = setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, 5_000);
    }
  });

  win.on('closed', clearForceCloseTimer);
}
