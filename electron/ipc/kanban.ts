import fs from 'fs';
import path from 'path';

import { atomicWriteFileSync } from '../mcp/atomic.js';
import { validatePath } from './validate.js';

/** The board lives at the project root as plain Markdown, so it can be read,
 *  edited and committed like any other file. */
export const KANBAN_FILE = 'KANBAN.md';

/** Far more than any board needs; keeps a stray huge file out of the renderer. */
export const KANBAN_MAX_BYTES = 1024 * 1024;

/** What is at `target`: nothing, a regular file, or anything else (a symlink, a folder). */
function entryAt(target: string): 'missing' | 'file' | 'other' {
  try {
    return fs.lstatSync(target).isFile() ? 'file' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

/** The board's path inside the project's real root. Validates before touching the disk. */
function boardPath(projectRoot: unknown): string {
  validatePath(projectRoot, 'projectRoot');
  const root = fs.realpathSync(projectRoot as string);
  if (!fs.statSync(root).isDirectory()) throw new Error('projectRoot must be a folder');
  return path.join(root, KANBAN_FILE);
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Reads the board through one descriptor that refuses symlinks and does not
 * block on a FIFO, checking type and size on that same descriptor, so nothing
 * swapped in between a check and the read is ever read. Null when absent.
 * Text that is not valid UTF-8 is refused: saving it back would replace bytes.
 */
function readBoardFile(target: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new Error(`${KANBAN_FILE} is not a regular file`);
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${KANBAN_FILE} is not a regular file`);
    if (stat.size > KANBAN_MAX_BYTES) throw new Error(`${KANBAN_FILE} is too large (max 1 MB)`);
    const buffer = Buffer.alloc(KANBAN_MAX_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > KANBAN_MAX_BYTES) throw new Error(`${KANBAN_FILE} is too large (max 1 MB)`);
    }
    try {
      return utf8.decode(buffer.subarray(0, length));
    } catch {
      throw new Error(
        `${KANBAN_FILE} is not valid UTF-8; fix the file's encoding to use the board`,
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** The board's Markdown, or null when the project has no board yet. */
export function readKanbanBoard(projectRoot: unknown): string | null {
  return readBoardFile(boardPath(projectRoot));
}

/**
 * Writes the board. `expected` is the text the caller last read: null creates
 * the file and refuses to replace one; a string replaces the file only while it
 * still holds exactly that text, so an edit made in another editor (or by an
 * agent) since the last read is never overwritten. A symlink is never followed.
 */
export function writeKanbanBoard(projectRoot: unknown, content: unknown, expected: unknown): void {
  if (typeof content !== 'string') throw new Error('content must be a string');
  if (expected !== null && typeof expected !== 'string') {
    throw new Error('expected must be a string or null');
  }
  if (Buffer.byteLength(content, 'utf8') > KANBAN_MAX_BYTES) {
    throw new Error(`The board is too large to save (max 1 MB)`);
  }
  const target = boardPath(projectRoot);
  const entry = entryAt(target);
  if (entry === 'other') throw new Error(`${KANBAN_FILE} is not a regular file`);
  if (expected === null) {
    if (entry === 'file') throw new Error(`${KANBAN_FILE} changed on disk; reload the board`);
  } else if (entry === 'missing' || readBoardFile(target) !== expected) {
    throw new Error(`${KANBAN_FILE} changed on disk; reload the board`);
  }
  atomicWriteFileSync(target, content);
}
