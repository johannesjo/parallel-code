import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { BrowserWindow } from 'electron';
import { IPC } from './channels.js';

interface PlanWatcher {
  fsWatchers: fs.FSWatcher[];
  timeout: ReturnType<typeof setTimeout> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  worktreePath: string;
  plansDirs: string[];
  watchedDirs: Set<string>;
}

const watchers = new Map<string, PlanWatcher>();
const exec = promisify(execFile);

/** Plan directories to watch, relative to worktree root. */
const PLAN_DIRS = ['.claude/plans', 'docs/plans', '.'];

/** How often to check for newly created plan directories (ms). */
const DIR_POLL_INTERVAL = 3_000;

/**
 * Reads and merges `.claude/settings.local.json` in the worktree to set
 * `plansDirectory: "./.claude/plans"`. Creates the plans dir if needed.
 * No-op if already set.
 *
 * Note: Claude may also write plans to `docs/plans/` independently;
 * `startPlanWatcher` monitors both locations.
 */
export function ensurePlansDirectory(worktreePath: string): void {
  const settingsPath = path.join(worktreePath, '.claude', 'settings.local.json');
  const plansDir = path.join(worktreePath, '.claude', 'plans');

  let settings: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[plans] settings.local.json is invalid, starting fresh:', e);
    }
    // File doesn't exist or is invalid — start fresh
  }

  if (settings.plansDirectory === './.claude/plans') {
    fs.mkdirSync(plansDir, { recursive: true });
    return;
  }

  settings.plansDirectory = './.claude/plans';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  fs.mkdirSync(plansDir, { recursive: true });
}

/** A plan file: its text, its name, and where it sits under the worktree. */
export interface PlanFile {
  content: string;
  fileName: string;
  /** Worktree-relative, with forward slashes; what the canvas opens. */
  relativePath: string;
}

function relativePlanPath(worktreePath: string, filePath: string): string {
  return path.relative(worktreePath, filePath).split(path.sep).join('/');
}

/** Dedicated plan directories accept every Markdown file. At the root, require
 * a plan/plans word in the filename so README.md and AGENTS.md stay out. */
function isPlanFile(worktreePath: string, plansDir: string, fileName: string): boolean {
  return (
    /\.md$/i.test(fileName) &&
    (path.relative(worktreePath, plansDir) !== '' ||
      /(?:^|[-_. ])plans?(?:$|[-_. ])/i.test(fileName.slice(0, -3)))
  );
}

function planFileNames(worktreePath: string, plansDir: string): string[] {
  try {
    return fs
      .readdirSync(plansDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isPlanFile(worktreePath, plansDir, entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Reads the newest plan file by mtime from a single directory. */
function readNewestPlan(
  worktreePath: string,
  plansDir: string,
  eligiblePaths?: ReadonlySet<string>,
): { content: string; fileName: string; filePath: string; mtime: number } | null {
  let newest: { name: string; mtime: number } | null = null;
  for (const fileName of planFileNames(worktreePath, plansDir)) {
    try {
      const filePath = path.join(plansDir, fileName);
      if (eligiblePaths && !eligiblePaths.has(relativePlanPath(worktreePath, filePath))) continue;
      const stat = fs.statSync(filePath);
      if (!newest || stat.mtimeMs > newest.mtime) {
        newest = { name: fileName, mtime: stat.mtimeMs };
      }
    } catch {
      // File may have been deleted between readdir and stat
    }
  }

  if (!newest) return null;

  const filePath = path.join(plansDir, newest.name);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { content, fileName: newest.name, filePath, mtime: newest.mtime };
  } catch (e) {
    console.warn('[plans] Failed to read plan file:', e);
    return null;
  }
}

/** Reads the newest plan across multiple directories. */
function readNewestPlanFromDirs(
  worktreePath: string,
  plansDirs: string[],
  eligiblePaths?: ReadonlySet<string>,
): PlanFile | null {
  let best: ReturnType<typeof readNewestPlan> = null;
  for (const dir of plansDirs) {
    const result = readNewestPlan(worktreePath, dir, eligiblePaths);
    if (result && (!best || result.mtime > best.mtime)) {
      best = result;
    }
  }
  return best
    ? {
        content: best.content,
        fileName: best.fileName,
        relativePath: relativePlanPath(worktreePath, best.filePath),
      }
    : null;
}

/** Recover task-local plans missed before startup without importing unchanged
 * committed plans from the repository. Include ignored Claude plan files. */
async function readUncommittedPlan(
  worktreePath: string,
  plansDirs: string[],
): Promise<PlanFile | null> {
  const candidates = plansDirs.flatMap((dir) =>
    planFileNames(worktreePath, dir).map((name) =>
      relativePlanPath(worktreePath, path.join(dir, name)),
    ),
  );
  if (candidates.length === 0) return null;
  const { stdout } = await exec(
    'git',
    [
      '--literal-pathspecs',
      'status',
      '--porcelain=v1',
      '-z',
      '--ignored',
      '--untracked-files=all',
      '--no-renames',
      '--',
      ...candidates,
    ],
    { cwd: worktreePath, timeout: 5_000 },
  );
  const changedPaths = new Set(
    stdout
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(3)),
  );
  return readNewestPlanFromDirs(worktreePath, plansDirs, changedPaths);
}

/** Sends plan content for a task to the renderer. */
function sendPlanContent(win: BrowserWindow, taskId: string, result: PlanFile | null): void {
  if (win.isDestroyed()) return;
  if (result) {
    win.webContents.send(IPC.PlanContent, { taskId, ...result });
  } else {
    win.webContents.send(IPC.PlanContent, {
      taskId,
      content: null,
      fileName: null,
      relativePath: null,
    });
  }
}

/** Start watching a single directory. Returns the watcher or null on failure. */
function watchDir(worktreePath: string, dir: string, onChange: () => void): fs.FSWatcher | null {
  try {
    const watcher = fs.watch(dir, (_event, fileName) => {
      if (fileName === null || isPlanFile(worktreePath, dir, fileName.toString())) onChange();
    });
    watcher.on('error', (err) => {
      console.warn(`Plan watcher error for ${dir}:`, err);
    });
    return watcher;
  } catch (err) {
    console.warn(`Failed to watch plan directory ${dir}:`, err);
    return null;
  }
}

/** Poll for plan directories that don't exist yet; start watching them when they appear. */
function startDirPolling(taskId: string, entry: PlanWatcher, onChange: () => void): void {
  if (entry.watchedDirs.size === entry.plansDirs.length) return;

  entry.pollTimer = setInterval(() => {
    const current = watchers.get(taskId);
    if (!current) return;

    let added = false;
    for (const dir of current.plansDirs) {
      if (current.watchedDirs.has(dir)) continue;
      if (!fs.existsSync(dir)) continue;
      const watcher = watchDir(current.worktreePath, dir, onChange);
      if (watcher) {
        current.fsWatchers.push(watcher);
        current.watchedDirs.add(dir);
        added = true;
      }
    }

    if (added) onChange();

    if (current.watchedDirs.size === current.plansDirs.length && current.pollTimer) {
      clearInterval(current.pollTimer);
      current.pollTimer = null;
    }
  }, DIR_POLL_INTERVAL);
}

/**
 * Watches plan directories for changes.
 * Monitors `.claude/plans/`, `docs/plans/`, and named plan files at the worktree root.
 * Directories that don't exist yet are polled periodically and watched
 * as soon as they appear (e.g. when an agent creates `docs/plans/`).
 * On change (debounced 200ms), reads the newest `.md` file by mtime
 * across all directories and sends it to the renderer via IPC.PlanContent.
 */
export function startPlanWatcher(win: BrowserWindow, taskId: string, worktreePath: string): void {
  stopPlanWatcher(taskId);

  const plansDirs = PLAN_DIRS.map((rel) => path.join(worktreePath, rel));
  const claudePlansDir = path.join(worktreePath, '.claude', 'plans');
  fs.mkdirSync(claudePlansDir, { recursive: true });

  const entry: PlanWatcher = {
    fsWatchers: [],
    timeout: null,
    pollTimer: null,
    worktreePath,
    plansDirs,
    watchedDirs: new Set(),
  };

  let changedSinceStart = false;
  const onChange = () => {
    changedSinceStart = true;
    const current = watchers.get(taskId);
    if (!current) return;
    if (current.timeout) clearTimeout(current.timeout);
    current.timeout = setTimeout(() => {
      current.timeout = null;
      sendPlanContent(win, taskId, readNewestPlanFromDirs(current.worktreePath, current.plansDirs));
    }, 200);
  };

  for (const dir of plansDirs) {
    if (!fs.existsSync(dir)) continue;
    const watcher = watchDir(worktreePath, dir, onChange);
    if (watcher) {
      entry.fsWatchers.push(watcher);
      entry.watchedDirs.add(dir);
    }
  }

  watchers.set(taskId, entry);
  startDirPolling(taskId, entry, onChange);
  void readUncommittedPlan(worktreePath, plansDirs)
    .then((plan) => {
      // A live event or a replacement watcher takes precedence over this startup read.
      if (plan && watchers.get(taskId) === entry && !changedSinceStart)
        sendPlanContent(win, taskId, plan);
    })
    .catch((error: unknown) => console.warn('[plans] Failed to recover existing plan:', error));
}

/** Stops and removes the plan watcher for a given task. */
export function stopPlanWatcher(taskId: string): void {
  const entry = watchers.get(taskId);
  if (!entry) return;
  if (entry.timeout) clearTimeout(entry.timeout);
  if (entry.pollTimer) clearInterval(entry.pollTimer);
  for (const w of entry.fsWatchers) {
    w.close();
  }
  watchers.delete(taskId);
}

/** Read a specific plan file from a worktree, or the newest if no name given. */
export function readPlanForWorktree(worktreePath: string, fileName?: string): PlanFile | null {
  const plansDirs = PLAN_DIRS.map((rel) => path.join(worktreePath, rel));

  if (fileName) {
    for (const dir of plansDirs) {
      if (!isPlanFile(worktreePath, dir, fileName)) continue;
      const filePath = path.join(dir, fileName);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return { content, fileName, relativePath: relativePlanPath(worktreePath, filePath) };
      } catch {
        // Not in this directory
      }
    }
    return null;
  }

  return readNewestPlanFromDirs(worktreePath, plansDirs);
}

/** Stops all plan watchers. */
export function stopAllPlanWatchers(): void {
  for (const taskId of watchers.keys()) {
    stopPlanWatcher(taskId);
  }
}
