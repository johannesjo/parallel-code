import fs from 'fs';
import path from 'path';
import type { BrowserWindow } from 'electron';
import { IPC } from './channels.js';

interface PlanWatcher {
  fsWatchers: fs.FSWatcher[];
  timeout: ReturnType<typeof setTimeout> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  plansDirs: string[];
  watchedDirs: Set<string>;
}

const watchers = new Map<string, PlanWatcher>();

/** Plan directories to watch, relative to worktree root. */
const PLAN_DIRS = ['.claude/plans', 'docs/plans'];

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

/** Reads the newest `.md` file by mtime from a single plans directory. */
function readNewestPlan(
  plansDir: string,
): { content: string; fileName: string; mtime: number } | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(plansDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const mdFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.md'));
  if (mdFiles.length === 0) return null;

  let newest: { name: string; mtime: number } | null = null;
  for (const file of mdFiles) {
    try {
      const filePath = path.join(plansDir, file.name);
      const stat = fs.statSync(filePath);
      if (!newest || stat.mtimeMs > newest.mtime) {
        newest = { name: file.name, mtime: stat.mtimeMs };
      }
    } catch {
      // File may have been deleted between readdir and stat
    }
  }

  if (!newest) return null;

  try {
    const content = fs.readFileSync(path.join(plansDir, newest.name), 'utf-8');
    return { content, fileName: newest.name, mtime: newest.mtime };
  } catch (e) {
    console.warn('[plans] Failed to read plan file:', e);
    return null;
  }
}

/** Reads the newest plan across multiple directories. */
function readNewestPlanFromDirs(plansDirs: string[]): { content: string; fileName: string } | null {
  let best: { content: string; fileName: string; mtime: number } | null = null;
  for (const dir of plansDirs) {
    const result = readNewestPlan(dir);
    if (result && (!best || result.mtime > best.mtime)) {
      best = result;
    }
  }
  return best ? { content: best.content, fileName: best.fileName } : null;
}

/** Sends plan content for a task to the renderer. */
function sendPlanContent(win: BrowserWindow, taskId: string, plansDirs: string[]): void {
  if (win.isDestroyed()) return;
  const result = readNewestPlanFromDirs(plansDirs);
  if (result) {
    win.webContents.send(IPC.PlanContent, {
      taskId,
      content: result.content,
      fileName: result.fileName,
    });
  } else {
    win.webContents.send(IPC.PlanContent, {
      taskId,
      content: null,
      fileName: null,
    });
  }
}

/** Start watching a single directory. Returns the watcher or null on failure. */
function watchDir(dir: string, onChange: () => void): fs.FSWatcher | null {
  try {
    const watcher = fs.watch(dir, onChange);
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
      const watcher = watchDir(dir, onChange);
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
 * Monitors both `.claude/plans/` and `docs/plans/` within the worktree.
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

  // Don't read existing plans on startup — fresh sessions should not
  // inherit stale plan files (e.g. committed docs/plans/ files that appear
  // in every worktree).  Restored/uncollapsed tasks already have their plan
  // content populated via the ReadPlanContent IPC in App.tsx.  New plans
  // written by the agent are picked up by the fs.watch onChange handler.

  const entry: PlanWatcher = {
    fsWatchers: [],
    timeout: null,
    pollTimer: null,
    plansDirs,
    watchedDirs: new Set(),
  };

  const onChange = () => {
    const current = watchers.get(taskId);
    if (!current) return;
    if (current.timeout) clearTimeout(current.timeout);
    current.timeout = setTimeout(() => {
      current.timeout = null;
      sendPlanContent(win, taskId, current.plansDirs);
    }, 200);
  };

  for (const dir of plansDirs) {
    if (!fs.existsSync(dir)) continue;
    const watcher = watchDir(dir, onChange);
    if (watcher) {
      entry.fsWatchers.push(watcher);
      entry.watchedDirs.add(dir);
    }
  }

  watchers.set(taskId, entry);
  startDirPolling(taskId, entry, onChange);
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
export function readPlanForWorktree(
  worktreePath: string,
  fileName?: string,
): { content: string; fileName: string } | null {
  const plansDirs = PLAN_DIRS.map((rel) => path.join(worktreePath, rel));

  if (fileName) {
    for (const dir of plansDirs) {
      try {
        const content = fs.readFileSync(path.join(dir, fileName), 'utf-8');
        return { content, fileName };
      } catch {
        // Not in this directory
      }
    }
    return null;
  }

  return readNewestPlanFromDirs(plansDirs);
}

/** Stops all plan watchers. */
export function stopAllPlanWatchers(): void {
  for (const taskId of watchers.keys()) {
    stopPlanWatcher(taskId);
  }
}
