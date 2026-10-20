import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  reasoningFeedPath,
  REASONING_MAX_BYTES,
  REASONING_MAX_UPDATES,
  type ReasoningFeedRead,
} from '../shared/reasoning.js';
import { validatePath } from './validate.js';
import { appendGitInfoExcludeBlock } from './git-exclude.js';
import { parseReasoningFeed, parseReasoningUpdate } from '../shared/reasoning-feed.js';
import { MAX_COORDINATOR_CONCURRENT_TASKS } from '../shared/coordinator-limits.js';
import {
  acceptUpdate,
  emptyHistory,
  type History,
  type InvestigationUpdate,
  type Snapshot,
} from '../shared/reasoning-state.js';

/** Walk every segment below the worktree so no link can redirect app-owned directories. */
function reasoningDirectory(worktreePath: string, relativeDir: string, create = false): string {
  validatePath(worktreePath, 'worktreePath');
  let directory = fs.realpathSync(worktreePath);
  for (const part of relativeDir.split('/')) {
    directory = path.join(directory, part);
    if (create) {
      try {
        fs.mkdirSync(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink()) throw new Error('Reasoning directories must not be symbolic links');
    if (!stat.isDirectory()) throw new Error('Invalid reasoning directory');
  }
  return directory;
}

function feedPath(worktreePath: string, taskId: string, agentId: string, create = false): string {
  const relative = reasoningFeedPath(taskId, agentId);
  const directory = reasoningDirectory(worktreePath, path.dirname(relative), create);
  return path.join(directory, path.basename(relative));
}

// Every append prepares the feed, and the exclude write shells out to `git rev-parse`;
// remember worktrees whose exclude file already carries the block so only the first
// append per worktree pays for the subprocess. A failure is not remembered.
const excludedWorktrees = new Set<string>();

function excludeReasoningFromGit(worktreePath: string): void {
  if (excludedWorktrees.has(worktreePath)) return;
  const result = appendGitInfoExcludeBlock(
    worktreePath,
    '/.parallel-code/reasoning/',
    '/.parallel-code/reasoning/\n',
  );
  if (result === 'failed') throw new Error('Could not exclude reasoning reports from Git');
  if (result !== 'missing') excludedWorktrees.add(worktreePath);
}

/** Prepare only app-owned directories; never truncate an existing report. */
export function prepareReasoningFeed(worktreePath: string, taskId: string, agentId: string): void {
  const file = feedPath(worktreePath, taskId, agentId, true);
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('Reasoning feed must be a regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  excludeReasoningFromGit(worktreePath);
}

export interface ReasoningFeedRef {
  worktreePath: string;
  taskId: string;
  agentId: string;
}

/** Cheap identity of the file's content: appends change size, rotation changes the inode. */
const feedStamp = (stat: fs.Stats): string => `${stat.mtimeMs}:${stat.size}:${stat.ino}`;

/** Bounded read of a regular file; no arbitrary renderer-supplied file paths.
 *  Pass the last `stamp` to skip reading a feed that has not changed. */
export async function readReasoningFeed(
  feed: ReasoningFeedRef,
  knownStamp?: string,
): Promise<ReasoningFeedRead | null> {
  try {
    const file = feedPath(feed.worktreePath, feed.taskId, feed.agentId);
    if (knownStamp) {
      const current = await fs.promises.lstat(file);
      if (current.isFile() && feedStamp(current) === knownStamp)
        return { unchanged: true, stamp: knownStamp };
    }
    return await readFeedFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readFeedFile(file: string): Promise<ReasoningFeedRead> {
  const handle = await fs.promises.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Reasoning feed must be a regular file');
    if ((await fs.promises.realpath(file)) !== file)
      throw new Error('Reasoning feed must not use symbolic links');
    const current = await fs.promises.lstat(file);
    if (current.dev !== stat.dev || current.ino !== stat.ino)
      throw new Error('Reasoning feed changed during read; retrying');
    if (stat.size > REASONING_MAX_BYTES) throw new Error('Reasoning feed too large (max 1 MB)');
    // Bound allocation and reading even if the agent appends after stat().
    const buffer = Buffer.alloc(REASONING_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > REASONING_MAX_BYTES) throw new Error('Reasoning feed too large (max 1 MB)');
    return { raw: buffer.toString('utf8', 0, size), stamp: feedStamp(stat) };
  } finally {
    await handle.close();
  }
}

/** Delete a task's report directory. Worktree removal covers worktree tasks; direct-mode
 *  tasks share the project checkout, so their reports would otherwise outlive the task. */
export function removeReasoningFeeds(worktreePath: string, taskId: string): void {
  let directory: string;
  try {
    // Every parent is checked too; rm unlinks nested links without following them.
    directory = reasoningDirectory(worktreePath, path.dirname(reasoningFeedPath(taskId, 'agent')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  fs.rmSync(directory, { recursive: true, force: true });
  forgetParsedFeeds(directory);
}

const OPEN_FLAGS =
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_APPEND |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK;

function readOpenFeed(fd: number, file: string): { stat: fs.Stats; raw: string; size: number } {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || fs.realpathSync(file) !== file)
    throw new Error('Reasoning feed must be a regular file without symbolic links');
  if (stat.size > REASONING_MAX_BYTES) throw new Error('Reasoning feed too large (max 1 MB)');
  const buffer = Buffer.alloc(REASONING_MAX_BYTES + 1);
  let size = 0;
  while (size < buffer.length) {
    const count = fs.readSync(fd, buffer, size, buffer.length - size, size);
    if (!count) break;
    size += count;
  }
  if (size > REASONING_MAX_BYTES) throw new Error('Reasoning feed too large (max 1 MB)');
  return { stat, raw: buffer.toString('utf8', 0, size), size };
}

function assertUnchanged(fd: number, file: string, stat: fs.Stats, size: number): void {
  const latest = fs.lstatSync(file);
  const opened = fs.fstatSync(fd);
  if (
    latest.dev !== stat.dev ||
    latest.ino !== stat.ino ||
    opened.size !== size ||
    opened.mtimeMs !== stat.mtimeMs
  )
    throw new Error('The reasoning report changed during publication. Read again.');
}

/** Archive a stuck or superseded report beside the feed; the fresh run starts in a new file. */
function rotateFeed(file: string, line: string): void {
  // Archives are audit history; a random suffix keeps two rotations in one millisecond apart.
  fs.renameSync(file, `${file}.${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function stuckError(error: string | undefined, pending: boolean): Error {
  const cause = error ?? (pending ? 'An update is still being written.' : '');
  return new Error(
    `${cause} To start over, read the current revision and supply newRunId; the current graph is archived.`.trim(),
  );
}

// Replaying the feed on every append costs O(updates × graph) — a clone and a full validation
// per line — synchronously on the main process: ~270 ms per append at 180 nodes and 300 updates.
// Remember what the last append produced so the parser can reuse the updates it already
// accepted. The remembered text is the proof: only a feed that still starts with it may reuse
// the history, so an out-of-band edit, a rollback or a rotation falls back to a full parse.
// The cache must clear the coordinator's ceiling: a run drives one feed per concurrent subtask
// plus its own, all appended to in round-robin. Size it below that and each feed evicts the next
// before its turn comes round again, so every append pays the full replay this cache exists to
// avoid — a cache that is worse than none.
// shortcut: entries are bounded, bytes are not. `history.snapshots` keeps a cloned graph per
// update against a per-feed cap of 1000 updates, so a full cache of long feeds is the ceiling
// here. Bound retained snapshots instead if that is ever reached in practice.
const MAX_CACHED_FEEDS = MAX_COORDINATOR_CONCURRENT_TASKS + 1;
const parsedFeeds = new Map<string, { raw: string; history: History }>();

/** Drop cached feeds under `directory`; their bytes are gone and must not be held for reuse. */
function forgetParsedFeeds(directory: string): void {
  const prefix = directory.endsWith(path.sep) ? directory : directory + path.sep;
  for (const file of parsedFeeds.keys()) if (file.startsWith(prefix)) parsedFeeds.delete(file);
}

function rememberParsedFeed(file: string, raw: string, history: History): void {
  parsedFeeds.delete(file);
  parsedFeeds.set(file, { raw, history });
  for (const oldest of parsedFeeds.keys()) {
    if (parsedFeeds.size <= MAX_CACHED_FEEDS) break;
    parsedFeeds.delete(oldest);
  }
}

function parseOpenFeed(file: string, raw: string): ReturnType<typeof parseReasoningFeed> {
  const cached = parsedFeeds.get(file);
  return parseReasoningFeed(raw, cached && raw.startsWith(cached.raw) ? cached.history : undefined);
}

/** Synchronous compare-and-append serializes MCP writers without rewriting history. */
export function appendReasoningUpdate(
  worktreePath: string,
  taskId: string,
  agentId: string,
  input: unknown,
  actor: 'user' | 'agent' = 'agent',
): Snapshot {
  const update = parseReasoningUpdate(input);
  prepareReasoningFeed(worktreePath, taskId, agentId);
  const file = feedPath(worktreePath, taskId, agentId);
  const fd = fs.openSync(file, OPEN_FLAGS, 0o600);
  try {
    const { stat, raw, size } = readOpenFeed(fd, file);
    const current = parseOpenFeed(file, raw);
    const stuck = !!current.error || current.pending;
    const currentRun = current.history.updates[0]?.runId ?? null;
    const revision = current.history.snapshots[current.history.snapshots.length - 1]?.revision ?? 0;
    if (update.runId !== currentRun || update.expectedRevision !== revision)
      throw new Error(
        'The graph revision or run changed. Use reasoning_read and retry with runId and expectedRevision.',
      );
    const fresh = update.newRunId !== undefined;
    if (actor === 'user' && fresh) throw new Error('User edits cannot replace a run.');
    if (!currentRun && !fresh) throw new Error('Supply newRunId to create the graph.');
    if (stuck && !fresh) throw stuckError(current.error, current.pending);
    const event: InvestigationUpdate = {
      runId: update.newRunId ?? currentRun ?? '',
      expectedRevision: fresh ? 0 : revision,
      operations: update.operations,
      sequence: fresh ? 0 : current.history.updates.length,
      actor,
      ...(update.caption !== undefined ? { caption: update.caption } : {}),
      ...(update.activeId !== undefined ? { activeId: update.activeId } : {}),
    };
    const next = acceptUpdate(fresh ? emptyHistory() : current.history, event);
    const line = JSON.stringify(event) + '\n';
    if (
      Buffer.byteLength(line) + (fresh ? 0 : size) > REASONING_MAX_BYTES ||
      next.updates.length > REASONING_MAX_UPDATES
    )
      throw new Error('Graph history is full; read the current revision and start a new run.');
    const snapshot = next.snapshots[next.snapshots.length - 1];
    if (!snapshot) throw new Error('Missing graph snapshot.');
    if (fresh && size) {
      assertUnchanged(fd, file, stat, size);
      rotateFeed(file, line);
      rememberParsedFeed(file, line, next);
      return snapshot;
    }
    assertUnchanged(fd, file, stat, size);
    fs.writeFileSync(fd, line);
    fs.fsyncSync(fd);
    rememberParsedFeed(file, raw + line, next);
    return snapshot;
  } finally {
    fs.closeSync(fd);
  }
}
