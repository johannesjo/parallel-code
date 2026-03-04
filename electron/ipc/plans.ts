import fs from 'fs';
import path from 'path';
import type { BrowserWindow } from 'electron';
import { IPC } from './channels.js';

interface PlanWatcher {
  watcher: fs.FSWatcher;
  timeout: ReturnType<typeof setTimeout> | null;
}

const watchers = new Map<string, PlanWatcher>();

/**
 * Reads and merges `.claude/settings.json` in the worktree to set
 * `plansDirectory: "./.claude/plans"`. Creates the plans dir if needed.
 * No-op if already set.
 */
export function ensurePlansDirectory(worktreePath: string): void {
  const settingsPath = path.join(worktreePath, '.claude', 'settings.json');
  const plansDir = path.join(worktreePath, '.claude', 'plans');

  let settings: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(raw) as Record<string, unknown>;
  } catch {
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

/** Reads the newest `.md` file by mtime from the plans directory. */
function readNewestPlan(plansDir: string): { content: string; fileName: string } | null {
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
    return { content, fileName: newest.name };
  } catch {
    return null;
  }
}

/** Sends plan content for a task to the renderer. */
function sendPlanContent(win: BrowserWindow, taskId: string, plansDir: string): void {
  if (win.isDestroyed()) return;
  const result = readNewestPlan(plansDir);
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

/**
 * Watches `{worktreePath}/.claude/plans/` for changes.
 * On change (debounced 200ms), reads the newest `.md` file by mtime
 * and sends it to the renderer via IPC.PlanContent.
 */
export function startPlanWatcher(win: BrowserWindow, taskId: string, worktreePath: string): void {
  stopPlanWatcher(taskId);

  const plansDir = path.join(worktreePath, '.claude', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });

  // Send initial content
  sendPlanContent(win, taskId, plansDir);

  const watcher = fs.watch(plansDir, () => {
    const entry = watchers.get(taskId);
    if (!entry) return;
    if (entry.timeout) clearTimeout(entry.timeout);
    entry.timeout = setTimeout(() => {
      entry.timeout = null;
      sendPlanContent(win, taskId, plansDir);
    }, 200);
  });

  watcher.on('error', () => {
    stopPlanWatcher(taskId);
  });

  watchers.set(taskId, { watcher, timeout: null });
}

/** Stops and removes the plan watcher for a given task. */
export function stopPlanWatcher(taskId: string): void {
  const entry = watchers.get(taskId);
  if (!entry) return;
  if (entry.timeout) clearTimeout(entry.timeout);
  entry.watcher.close();
  watchers.delete(taskId);
}

/** Stops all plan watchers. */
export function stopAllPlanWatchers(): void {
  for (const taskId of watchers.keys()) {
    stopPlanWatcher(taskId);
  }
}
