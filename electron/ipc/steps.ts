import fs from 'fs';
import path from 'path';
import type { Notify } from './notify.js';
import { IPC } from './channels.js';
import { appendGitInfoExcludeBlock } from './git-exclude.js';
import {
  debug as logDebug,
  info as logInfo,
  warn as logWarn,
  error as logError,
  errMessage,
} from '../log.js';

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
function sendStepsContent(notify: Notify, taskId: string, stepsFile: string): void {
  const steps = readStepsFile(stepsFile);
  logInfo('steps', 'send', { taskId, len: steps?.length ?? null });
  if (steps) applyTimestamps(steps, stepsFile, taskId);
  notify(IPC.StepsContent, { taskId, steps });
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
    logWarn('steps', 'failed to write back timestamps', { err: errMessage(err) });
  }
}

function isStepObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parses the canonical JSON array plus the single-object / JSONL forms that
 * append-oriented agents commonly produce. The watcher normalizes supported
 * alternatives back to an array when it adds host timestamps.
 */
export function parseStepsContent(raw: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return isStepObject(parsed) ? [parsed] : null;
  } catch {
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;

    try {
      const entries: unknown[] = lines.map((line) => JSON.parse(line) as unknown);
      return entries.every(isStepObject) ? entries : null;
    } catch {
      return null;
    }
  }
}

/** Reads and parses `.claude/steps.json`. Returns the entries or null. */
function readStepsFile(stepsFile: string): unknown[] | null {
  try {
    const raw = fs.readFileSync(stepsFile, 'utf-8');
    const steps = parseStepsContent(raw);
    if (!steps) logWarn('steps', 'invalid steps file format', { stepsFile });
    return steps;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Non-ENOENT read failures (corrupt file, permissions, etc.)
      // capture the full stack via the structured logger.
      logError('steps', 'failed to read steps file', e);
    }
    return null;
  }
}

/**
 * Resolves the path to the git exclude file for a given worktree.
 * For linked worktrees, .git is a file pointing to the actual git dir.
 */
function ensureStepsIgnored(worktreePath: string): void {
  appendGitInfoExcludeBlock(worktreePath, '.claude/steps.json', '.claude/steps.json\n', (err) => {
    logWarn('steps', 'failed to update git exclude', { err: errMessage(err) });
  });
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
export function startStepsWatcher(notify: Notify, taskId: string, worktreePath: string): void {
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
  const onChange = (event: string, filename: string | Buffer | null) => {
    logDebug('steps', 'watch event', { taskId, event, filename: String(filename) });
    if (filename !== null && filename !== 'steps.json') return;
    const current = watchers.get(taskId);
    if (!current) return;
    if (current.timeout) clearTimeout(current.timeout);
    current.timeout = setTimeout(() => {
      current.timeout = null;
      sendStepsContent(notify, taskId, current.stepsFile);
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
          sendStepsContent(notify, taskId, stepsFile);
        }
      });
      parentWatcher.on('error', (err) => {
        logError('steps', 'parent watcher error', err, { worktreePath });
      });
      entry.fsWatcher = parentWatcher;
    } catch (err) {
      logError('steps', 'failed to watch worktree root', err, { worktreePath });
    }
  }

  watchers.set(taskId, entry);

  // Initial read to catch files written before the watcher was set up
  if (fs.existsSync(stepsFile)) {
    sendStepsContent(notify, taskId, stepsFile);
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
      logError('steps', 'watcher error', err, { stepsDir: entry.stepsDir });
    });
    entry.fsWatcher = watcher;
    watchers.set(taskId, entry);
  } catch (err) {
    logError('steps', 'failed to watch steps dir', err, { stepsDir: entry.stepsDir });
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
