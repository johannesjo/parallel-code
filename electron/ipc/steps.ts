import fs from 'fs';
import path from 'path';
import type { BrowserWindow } from 'electron';
import { IPC } from './channels.js';

interface StepsWatcher {
  fsWatcher: fs.FSWatcher | null;
  timeout: ReturnType<typeof setTimeout> | null;
  stepsDir: string;
  stepsFile: string;
}

const watchers = new Map<string, StepsWatcher>();

/**
 * Tracks how many entries have already been processed (timestamped) per task.
 * Any entry at an index >= processedCount is considered new and will have its
 * timestamp overwritten with the host clock — regardless of what the AI wrote.
 * Entries below that index keep their existing timestamps (they were stamped by
 * us on a previous read, possibly before an app restart).
 *
 * A missing map entry means we haven't observed this task yet in this process —
 * on that first read we only fill in missing timestamps and seed the counter,
 * so existing stamps from prior sessions survive a restart.
 */
const processedCount = new Map<string, number>();

/** Sends parsed steps content for a task to the renderer. */
function sendStepsContent(win: BrowserWindow, taskId: string, stepsFile: string): void {
  if (win.isDestroyed()) return;
  const steps = readStepsFile(stepsFile);
  if (steps) applyTimestamps(steps, stepsFile, taskId);
  win.webContents.send(IPC.StepsContent, { taskId, steps });
}

/**
 * Stamps timestamps on new entries (indices >= processedCount) with the host
 * clock, overwriting whatever the AI may have written. Existing entries that
 * already have a timestamp are left alone. Writes the file back when anything
 * changed; the subsequent watcher event finds nothing new and stops.
 */
function applyTimestamps(steps: unknown[], stepsFile: string, taskId: string): void {
  const firstRun = !processedCount.has(taskId);
  const prevCount = processedCount.get(taskId) ?? steps.length;
  const now = new Date().toISOString();
  let dirty = false;

  for (let i = 0; i < steps.length; i++) {
    const entry = steps[i];
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      const isNew = !firstRun && i >= prevCount;
      if (isNew || !e['timestamp']) {
        e['timestamp'] = now;
        dirty = true;
      }
    }
  }

  processedCount.set(taskId, steps.length);

  if (!dirty) return;
  try {
    fs.writeFileSync(stepsFile, JSON.stringify(steps, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[steps] Failed to write back timestamps:', err);
  }
}

/** Reads and parses `.claude/steps.json`. Returns the array or null. */
function readStepsFile(stepsFile: string): unknown[] | null {
  try {
    const raw = fs.readFileSync(stepsFile, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as unknown[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[steps] Failed to read steps file:', e);
    }
    return null;
  }
}

/**
 * Resolves the path to the git exclude file for a given worktree.
 * For linked worktrees, .git is a file pointing to the actual git dir.
 */
function getGitExcludePath(worktreePath: string): string | null {
  const gitPath = path.join(worktreePath, '.git');
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) {
      return path.join(gitPath, 'info', 'exclude');
    }
    // Linked worktree: .git is a file "gitdir: /path/to/.git/worktrees/<name>"
    const content = fs.readFileSync(gitPath, 'utf-8').trim();
    const match = /^gitdir: (.+)$/.exec(content);
    if (!match) return null;
    return path.join(match[1], 'info', 'exclude');
  } catch {
    return null;
  }
}

/**
 * Ensures `.claude/steps.json` is excluded from git via the worktree's
 * `.git/info/exclude` (local, never committed) so the file never shows up
 * in the user's diff.
 */
function ensureStepsIgnored(worktreePath: string): void {
  const excludePath = getGitExcludePath(worktreePath);
  if (!excludePath) return;
  const entry = '.claude/steps.json';
  try {
    let content = '';
    if (fs.existsSync(excludePath)) {
      content = fs.readFileSync(excludePath, 'utf-8');
      if (content.split('\n').some((line) => line.trim() === entry)) return;
    } else {
      fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    }
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(excludePath, `${prefix}${entry}\n`, 'utf-8');
  } catch (err) {
    console.warn('Failed to update git exclude for steps:', err);
  }
}

/**
 * Watches the `.claude` directory for changes to `steps.json`.
 *
 * We watch the directory (not the file) because `fs.watch` on a single
 * file is unreliable with atomic writes (temp-file-then-rename),
 * especially on macOS. Changes are debounced (200ms) before reading.
 *
 * If `.claude/` doesn't exist yet (fresh worktree), we watch the worktree
 * root until the directory appears, then swap to watching `.claude/`.
 *
 * An initial read is performed after starting the watcher to handle
 * the race condition where the agent writes before the watcher is set up.
 */
export function startStepsWatcher(win: BrowserWindow, taskId: string, worktreePath: string): void {
  stopStepsWatcher(taskId);
  ensureStepsIgnored(worktreePath);

  const stepsDir = path.join(worktreePath, '.claude');
  const stepsFile = path.join(stepsDir, 'steps.json');

  const entry: StepsWatcher = {
    fsWatcher: null,
    timeout: null,
    stepsDir,
    stepsFile,
  };

  // filename may be null on some platforms; if present, filter to steps.json only
  const onChange = (_event: string, filename: string | Buffer | null) => {
    if (filename !== null && filename !== 'steps.json') return;
    const current = watchers.get(taskId);
    if (!current) return;
    if (current.timeout) clearTimeout(current.timeout);
    current.timeout = setTimeout(() => {
      current.timeout = null;
      sendStepsContent(win, taskId, current.stepsFile);
    }, 200);
  };

  if (fs.existsSync(stepsDir)) {
    // .claude/ already exists — watch it directly
    attachStepsDirWatcher(entry, taskId, onChange);
  } else {
    // .claude/ doesn't exist yet — watch the worktree root until it appears
    try {
      const parentWatcher = fs.watch(worktreePath, (_event, filename) => {
        if (filename !== '.claude') return;
        if (!fs.existsSync(stepsDir)) return;
        // .claude/ just appeared — swap to watching it
        parentWatcher.close();
        const current = watchers.get(taskId);
        if (!current) return;
        attachStepsDirWatcher(current, taskId, onChange);
        if (fs.existsSync(stepsFile)) {
          sendStepsContent(win, taskId, stepsFile);
        }
      });
      parentWatcher.on('error', (err) => {
        console.warn(`Steps parent watcher error for ${worktreePath}:`, err);
      });
      entry.fsWatcher = parentWatcher;
    } catch (err) {
      console.warn(`Failed to watch worktree root ${worktreePath}:`, err);
    }
  }

  watchers.set(taskId, entry);

  // Initial read to catch files written before the watcher was set up
  if (fs.existsSync(stepsFile)) {
    sendStepsContent(win, taskId, stepsFile);
  }
}

/** Attaches an fs.watch on the `.claude` directory and stores it on the entry. */
function attachStepsDirWatcher(
  entry: StepsWatcher,
  taskId: string,
  onChange: (event: string, filename: string | Buffer | null) => void,
): void {
  try {
    const watcher = fs.watch(entry.stepsDir, onChange);
    watcher.on('error', (err) => {
      console.warn(`Steps watcher error for ${entry.stepsDir}:`, err);
    });
    entry.fsWatcher = watcher;
    watchers.set(taskId, entry);
  } catch (err) {
    console.warn(`Failed to watch steps directory ${entry.stepsDir}:`, err);
  }
}

/** Stops and removes the steps watcher for a given task. */
export function stopStepsWatcher(taskId: string): void {
  const entry = watchers.get(taskId);
  if (!entry) return;
  if (entry.timeout) clearTimeout(entry.timeout);
  if (entry.fsWatcher) entry.fsWatcher.close();
  watchers.delete(taskId);
  processedCount.delete(taskId);
}

/** Read steps.json from a worktree. Used for one-shot restore. */
export function readStepsForWorktree(worktreePath: string): unknown[] | null {
  const stepsFile = path.join(worktreePath, '.claude', 'steps.json');
  return readStepsFile(stepsFile);
}

/** Stops all steps watchers. */
export function stopAllStepsWatchers(): void {
  for (const taskId of watchers.keys()) {
    stopStepsWatcher(taskId);
  }
}
