/**
 * Quick edit: a document that lives somewhere the workspace must not commit —
 * a code repository, a task worktree, a docs folder inside a repo — worked on
 * without a document project of its own. The workspace runs unchanged against
 * a private copy: a repository under the app's data folder holding just that
 * file, kept in step with the original in both directions while the app runs.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { git } from './git.js';
import {
  inspectDocumentFolder,
  isDocument,
  prepareDocumentProject,
  repoToplevel,
  starterContent,
} from './setup.js';
import { atomicWriteFileSync } from '../mcp/atomic.js';
import type { DocumentProjectSetup, QuickEditTarget } from './types.js';
import { errMessage, warn } from '../log.js';

const QUICK_EDIT_DIR = 'quick-edits';
/**
 * Polling, not `fs.watch`: git checkouts and editors replace the file, which a
 * watch on it loses. Not `fs.watchFile` either: its first stat is taken
 * asynchronously, so a write landing before it is never reported. Comparing the
 * bytes each tick costs three reads of one document.
 */
const SYNC_POLL_MS = 700;

interface SyncFiles {
  source: string;
  copy: string;
}

interface Sync extends SyncFiles {
  timer: ReturnType<typeof setInterval>;
  /** A failure repeats every poll until fixed, so it is reported once until a sync works. */
  failing: boolean;
}

const syncs = new Map<string, Sync>();

/** What a running sync has to tell the user, such as where a clash was kept. */
export interface QuickEditWarning {
  sourcePath: string;
  message: string;
}

let tellUser: (warning: QuickEditWarning) => void = () => {};

/** Where warnings found between opens go; opening returns its own. */
export function onQuickEditWarning(listener: (warning: QuickEditWarning) => void): void {
  tellUser = listener;
}

/** Where quick-edit copies live; any root handed back from the renderer must sit in here. */
function quickEditBase(dataDir: string): string {
  return path.join(dataDir, QUICK_EDIT_DIR);
}

/** One copy per original file, so reopening it finds its runs and history again. */
function copyRoot(dataDir: string, realSource: string): string {
  const hash = crypto.createHash('sha256').update(realSource).digest('hex').slice(0, 16);
  return path.join(quickEditBase(dataDir), hash);
}

/** Bytes, not text: a document that is not UTF-8 must come back unchanged. */
function readIfPresent(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    // A git checkout replaces the file in two steps; the next poll sees it again.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** What both sides held after the last sync; beside the copy's repository, so never committed. */
function syncedRecord(root: string): string {
  return `${root}.synced`;
}

/** Saves the copy's side of a clash where the user can find it, and says so. */
function keepConflict(root: string, files: SyncFiles, copied: Buffer): string {
  // A new file per clash, so a second one never overwrites what the first set aside.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const kept = `${root}.conflict-${stamp}${path.extname(files.copy)}`;
  atomicWriteFileSync(kept, copied);
  return `Quick edit changed on both sides; kept the original and saved the copy's version to ${kept}`;
}

/**
 * Brings the original and the copy level. The side that still matches the last
 * synced bytes is the one that did not change, so the other side wins; that also
 * covers edits made while the app was closed or between two polls. Equal sides
 * are what stops the two directions echoing. Returns a warning, if any.
 */
// shortcut: when both sides changed the original wins and the copy's version is
// set aside in a file — a three-way text merge if users lose work to that.
function reconcile(root: string, files: SyncFiles, atOpen: boolean): string | null {
  const original = readIfPresent(files.source);
  // A moved or deleted original is not brought back from the copy.
  if (original === null) return null;
  const copied = readIfPresent(files.copy);
  // Between polls a missing copy is a checkout replacing it; only opening restores it.
  if (copied === null && !atOpen) return null;
  const synced = readIfPresent(syncedRecord(root));
  let settled = original;
  let warning: string | null = null;
  if (copied === null) atomicWriteFileSync(files.copy, original);
  else if (copied.equals(original)) {
    // Already level.
  } else if (synced?.equals(original)) {
    // In place, unlike the app's own files: a rename would cut hard links to the
    // user's file and drop a temp file into their repository.
    fs.writeFileSync(files.source, copied);
    settled = copied;
  } else {
    if (synced !== null && !synced.equals(copied)) warning = keepConflict(root, files, copied);
    atomicWriteFileSync(files.copy, original);
  }
  if (!synced?.equals(settled)) atomicWriteFileSync(syncedRecord(root), settled);
  return warning;
}

function reconcileSafely(root: string, sync: Sync): void {
  let message: string | null;
  try {
    message = reconcile(root, sync, false);
    sync.failing = false;
  } catch (err) {
    if (sync.failing) return;
    sync.failing = true;
    message = `Quick edit sync failed: ${errMessage(err)}`;
  }
  if (message === null) return;
  warn('documents', message, { source: sync.source });
  tellUser({ sourcePath: sync.source, message });
}

function startSync(root: string, files: SyncFiles): void {
  if (syncs.has(root)) return;
  const timer = setInterval(() => {
    const sync = syncs.get(root);
    if (sync) reconcileSafely(root, sync);
  }, SYNC_POLL_MS);
  // Syncing never keeps the app (or a test run) alive on its own.
  timer.unref();
  syncs.set(root, { ...files, timer, failing: false });
}

/** Stops keeping one quick edit in step; the last changes are written across first. */
export function stopQuickEditSync(root: string): void {
  const sync = syncs.get(root);
  if (!sync) return;
  clearInterval(sync.timer);
  syncs.delete(root);
  reconcileSafely(root, sync);
}

export function stopAllQuickEditSyncs(): void {
  for (const root of [...syncs.keys()]) stopQuickEditSync(root);
}

function validateSource(sourcePath: unknown, create: boolean): string {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath))
    throw new Error('The document path has to be absolute.');
  if (!isDocument(sourcePath)) throw new Error('Only Markdown and HTML files open as documents.');
  if (!fs.existsSync(sourcePath)) {
    if (!create) throw new Error(`${sourcePath} does not exist.`);
    if (!fs.existsSync(path.dirname(sourcePath)))
      throw new Error(`The folder ${path.dirname(sourcePath)} does not exist.`);
    // `wx`: a dangling link under a document name is not followed to create its target.
    fs.writeFileSync(sourcePath, starterContent(path.basename(sourcePath)), { flag: 'wx' });
  }
  // The name checked above may be a link; what gets read and written is its target.
  const real = fs.realpathSync(sourcePath);
  if (!isDocument(real)) throw new Error('Only Markdown and HTML files open as documents.');
  if (!fs.statSync(real).isFile()) throw new Error(`${sourcePath} is not a file.`);
  return real;
}

/**
 * Opens `sourcePath` for quick editing: brings its private copy up to date
 * with the original, sets the copy's repository up the first time, and keeps
 * the two in step from then on. `create` writes a starter file first when the
 * original does not exist yet.
 */
// shortcut: agents see only the copied document, not the code beside the
// original — grant read access to its folder (claude `--add-dir`) if they need context.
export async function openQuickEdit(
  dataDir: string,
  sourcePath: unknown,
  create = false,
): Promise<QuickEditTarget> {
  const source = validateSource(sourcePath, create);
  const projectRoot = copyRoot(dataDir, source);
  const documentPath = path.basename(source);
  const copy = path.join(projectRoot, documentPath);
  fs.mkdirSync(projectRoot, { recursive: true });
  // Its own repository before setup looks: a data folder inside a dotfiles
  // repository would otherwise read as a folder nested in someone else's repo.
  if (!fs.existsSync(path.join(projectRoot, '.git')))
    await git(projectRoot, ['init', '-q', '-b', 'main']);
  const warning = reconcile(projectRoot, { source, copy }, true);
  if (warning) warn('documents', warning, { source });
  await prepareDocumentProject(projectRoot, documentPath);
  startSync(projectRoot, { source, copy });
  return { projectRoot, documentPath, sourcePath: source, ...(warning ? { warning } : {}) };
}

function nearestExisting(folder: string): string {
  let dir = path.resolve(folder);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

/**
 * Copies a quick edit's document into `folder` and makes that a document
 * project of its own. The original stays where it was; the copy keeps
 * syncing to it only until this succeeds.
 */
export async function convertQuickEdit(
  dataDir: string,
  projectRoot: string,
  documentPath: string,
  folder: string,
): Promise<DocumentProjectSetup> {
  const root = path.resolve(projectRoot);
  if (path.dirname(root) !== quickEditBase(dataDir) || documentPath !== path.basename(documentPath))
    throw new Error('That is not a quick edit.');
  if (!path.isAbsolute(folder)) throw new Error('The folder path has to be absolute.');
  const target = path.resolve(folder);
  await refuseFolder(target);
  const sync = syncs.get(root);
  // Edits made to the original since the last poll come along too.
  if (sync) reconcileSafely(root, sync);
  const content = readIfPresent(path.join(root, documentPath));
  if (content === null) throw new Error(`${documentPath} is missing from the quick edit.`);
  return createProjectFrom({ root, folder: target, documentPath, content });
}

/** Writes the moved document and sets its project up, or leaves nothing behind. */
async function createProjectFrom(move: {
  root: string;
  folder: string;
  documentPath: string;
  content: Buffer;
}): Promise<DocumentProjectSetup> {
  const file = path.join(move.folder, move.documentPath);
  if (fs.existsSync(file)) throw new Error(`${file} already exists.`);
  const gitDir = path.join(move.folder, '.git');
  const hadGit = fs.existsSync(gitDir);
  const created = fs.mkdirSync(move.folder, { recursive: true });
  try {
    fs.writeFileSync(file, move.content, { flag: 'wx' });
    const setup = await prepareDocumentProject(move.folder, move.documentPath);
    stopQuickEditSync(move.root);
    return setup;
  } catch (err) {
    // Leave nothing half made, so trying again does not trip over it.
    if (created) fs.rmSync(created, { recursive: true, force: true });
    else {
      fs.rmSync(file, { force: true });
      if (!hadGit) fs.rmSync(gitDir, { recursive: true, force: true });
    }
    throw err;
  }
}

/**
 * Everything that can refuse is checked before anything is written. A folder
 * still to be made is judged by the nearest one that exists.
 */
async function refuseFolder(folder: string): Promise<void> {
  const existing = nearestExisting(folder);
  // A folder still to be made holds nothing yet; only a repository around it matters.
  const info = existing === folder ? await inspectDocumentFolder(folder) : null;
  const repo = info ? info.enclosingRepo : await repoToplevel(existing);
  if (repo)
    throw new Error(
      `That folder is inside the Git repository at ${repo}. Pick a folder outside it.`,
    );
  // The point of moving out is to stop committing next to code.
  if (info?.looksLikeCode)
    throw new Error(`${folder} holds code. Pick a folder of its own for the document.`);
}
