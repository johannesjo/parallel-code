import fs from 'fs';
import path from 'path';
import { atomicWriteFileSync } from '../mcp/atomic.js';
import { errMessage, warn as logWarn } from '../log.js';

/**
 * Journal of task worktrees that were provisioned but not yet in a saved state.
 *
 * Every task path writes its worktree before the renderer's debounced autosave
 * records the task, so a crash in between leaves a worktree nothing refers to.
 * An intent is written before provisioning and dropped once a saved state claims
 * its path. Only this instance's own intents are reported: a dev run and an
 * installed build share repositories but not state, and Arena and document-run
 * worktrees live in the same `.worktrees/` directory without being tasks, so
 * scanning `git worktree list` would report worktrees that are not orphans.
 */
export interface WorktreeIntent {
  worktreePath: string;
  branchName: string;
  projectRoot: string;
  createdAt: string;
}

const JOURNAL_VERSION = 1;

let journalPath: string | null = null;
const pending = new Map<string, WorktreeIntent>();

function isIntent(value: unknown): value is WorktreeIntent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.worktreePath === 'string' &&
    typeof v.branchName === 'string' &&
    typeof v.projectRoot === 'string' &&
    typeof v.createdAt === 'string'
  );
}

// The journal is a safety net: an unreadable or unwritable journal is logged
// and must never block startup, task creation or saving app state.
function readJournal(file: string): WorktreeIntent[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const intents = (parsed as { intents?: unknown } | null)?.intents;
    return Array.isArray(intents) ? intents.filter(isIntent) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logWarn('worktrees', 'unreadable worktree intent journal', { err: errMessage(err) });
    }
    return [];
  }
}

function writeJournal(): void {
  if (!journalPath) return;
  const data = { version: JOURNAL_VERSION, intents: [...pending.values()] };
  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    atomicWriteFileSync(journalPath, JSON.stringify(data, null, 2) + '\n');
  } catch (err) {
    logWarn('worktrees', 'failed to write worktree intent journal', { err: errMessage(err) });
  }
}

/** Worktree paths of the tasks in a saved app state. Malformed input claims nothing. */
function claimedWorktreePaths(stateJson: string | null): Set<string> {
  const claimed = new Set<string>();
  if (!stateJson) return claimed;
  let tasks: unknown;
  try {
    tasks = (JSON.parse(stateJson) as { tasks?: unknown } | null)?.tasks;
  } catch (err) {
    logWarn('worktrees', 'unparseable app state', { err: errMessage(err) });
    return claimed;
  }
  if (typeof tasks !== 'object' || tasks === null) return claimed;
  for (const task of Object.values(tasks)) {
    const p = (task as { worktreePath?: unknown } | null)?.worktreePath;
    if (typeof p === 'string') claimed.add(path.resolve(p));
  }
  return claimed;
}

/**
 * Open the journal at startup and return the orphans: intents whose worktree
 * exists but that no saved task claims. Orphans stay in the journal, so they
 * are reported again on each start until the worktree is removed; they may hold
 * user work, so nothing is deleted here. Must run before any task is created.
 */
export function reconcileWorktreeIntents(
  file: string,
  savedStateJson: string | null,
): WorktreeIntent[] {
  journalPath = file;
  pending.clear();
  const claimed = claimedWorktreePaths(savedStateJson);
  const intents = readJournal(file);
  for (const intent of intents) {
    const key = path.resolve(intent.worktreePath);
    if (claimed.has(key) || !fs.existsSync(key)) continue;
    pending.set(key, intent);
  }
  if (pending.size !== intents.length) writeJournal();
  return [...pending.values()];
}

/** Record a worktree about to be provisioned. A no-op until the journal is opened. */
export function recordWorktreeIntent(intent: Omit<WorktreeIntent, 'createdAt'>): void {
  if (!journalPath) return;
  const entry = { ...intent, createdAt: new Date().toISOString() };
  pending.set(path.resolve(intent.worktreePath), entry);
  writeJournal();
}

/** Drop the intents a just-saved app state claims. */
export function settleWorktreeIntents(savedStateJson: string): void {
  if (pending.size === 0) return;
  let changed = false;
  for (const key of claimedWorktreePaths(savedStateJson)) {
    changed = pending.delete(key) || changed;
  }
  if (changed) writeJournal();
}
