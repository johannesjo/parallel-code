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

/** Sends parsed steps content for a task to the renderer. */
function sendStepsContent(win: BrowserWindow, taskId: string, stepsFile: string): void {
  if (win.isDestroyed()) return;
  const steps = readStepsFile(stepsFile);
  win.webContents.send(IPC.StepsContent, { taskId, steps });
}

/** Reads and parses `.claude/steps.json`. Returns the array or null. */
function readStepsFile(stepsFile: string): unknown[] | null {
  try {
    const raw = fs.readFileSync(stepsFile, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as unknown[];
  } catch {
    return null;
  }
}

/**
 * Watches the `.claude` directory for changes to `steps.json`.
 *
 * We watch the directory (not the file) because `fs.watch` on a single
 * file is unreliable with atomic writes (temp-file-then-rename),
 * especially on macOS. Changes are debounced (200ms) before reading.
 *
 * An initial read is performed after starting the watcher to handle
 * the race condition where the agent writes before the watcher is set up.
 */
export function startStepsWatcher(win: BrowserWindow, taskId: string, worktreePath: string): void {
  stopStepsWatcher(taskId);

  const stepsDir = path.join(worktreePath, '.claude');
  const stepsFile = path.join(stepsDir, 'steps.json');

  const entry: StepsWatcher = {
    fsWatcher: null,
    timeout: null,
    stepsDir,
    stepsFile,
  };

  const onChange = () => {
    const current = watchers.get(taskId);
    if (!current) return;
    if (current.timeout) clearTimeout(current.timeout);
    current.timeout = setTimeout(() => {
      current.timeout = null;
      sendStepsContent(win, taskId, current.stepsFile);
    }, 200);
  };

  // Start watching the .claude directory
  if (fs.existsSync(stepsDir)) {
    try {
      entry.fsWatcher = fs.watch(stepsDir, onChange);
      entry.fsWatcher.on('error', (err) => {
        console.warn(`Steps watcher error for ${stepsDir}:`, err);
      });
    } catch (err) {
      console.warn(`Failed to watch steps directory ${stepsDir}:`, err);
    }
  }

  watchers.set(taskId, entry);

  // Initial read to catch files written before the watcher was set up
  if (fs.existsSync(stepsFile)) {
    sendStepsContent(win, taskId, stepsFile);
  }
}

/** Stops and removes the steps watcher for a given task. */
export function stopStepsWatcher(taskId: string): void {
  const entry = watchers.get(taskId);
  if (!entry) return;
  if (entry.timeout) clearTimeout(entry.timeout);
  if (entry.fsWatcher) entry.fsWatcher.close();
  watchers.delete(taskId);
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
