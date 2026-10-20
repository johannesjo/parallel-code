import fs from 'fs';
import path from 'path';

import { atomicWriteFileSync } from '../mcp/atomic.js';
import {
  TOUR_FILE_CHANGED,
  TOUR_FILE_MAX_CHARS,
  TOUR_FILE_SUFFIX,
} from '../shared/understanding-limits.js';

/** Enough numbered names for any one subject; past that the reader should tidy up. */
const MAX_NAME_ATTEMPTS = 50;

/**
 * Normalizes a worktree-relative `.tour.md` path, rejecting anything that
 * could escape the worktree or land in git's or the app's own folders. Runs
 * before any filesystem access.
 */
function tourFilePath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('path must be a string');
  const segments = value
    .trim()
    .split(/[\\/]/)
    .filter((segment) => segment !== '' && segment !== '.');
  if (!segments.length || path.isAbsolute(value.trim()))
    throw new Error('path must be relative to the worktree');
  if (segments.includes('..')) throw new Error('path must not contain ".."');
  if (segments.some((segment) => /^\.(git|parallel|parallel-code|worktrees)$/i.test(segment)))
    throw new Error('path must not point into .git or the app folders');
  const relative = segments.join('/');
  if (!relative.toLowerCase().endsWith(TOUR_FILE_SUFFIX))
    throw new Error(`Only ${TOUR_FILE_SUFFIX} files can be saved`);
  return relative;
}

/** `name.tour.md`, then `name-2.tour.md`, `name-3.tour.md` and so on. */
function numbered(relative: string, attempt: number): string {
  if (attempt === 1) return relative;
  const stem = relative.slice(0, -TOUR_FILE_SUFFIX.length);
  return `${stem}-${attempt}${TOUR_FILE_SUFFIX}`;
}

/** Whether the file no longer holds `expected`; a size mismatch spares reading it. */
function changed(target: string, expected: string): boolean {
  if (fs.statSync(target).size !== Buffer.byteLength(expected, 'utf8')) return true;
  return fs.readFileSync(target, 'utf8') !== expected;
}

/** What is at `target`: nothing, a regular file, or anything else. */
function entryAt(target: string): 'missing' | 'file' | 'other' {
  try {
    return fs.lstatSync(target).isFile() ? 'file' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

/**
 * Writes a saved understanding tour into the worktree and returns the path it
 * landed at. A first save never overwrites: an existing file of that name
 * moves the tour to the next free numbered name. Later saves of the same tour
 * pass `replace` and update their own file, and must pass `expected`, the text
 * they last wrote or read: a file someone edited or removed since is refused,
 * not overwritten or recreated.
 * Either way the target must be a regular file in a folder that really is
 * inside the worktree, so a symlink can never carry the write out of it.
 */
export function saveTourFile(
  worktreePath: string,
  args: { path: unknown; content: unknown; replace: unknown; expected?: unknown },
): string {
  const relative = tourFilePath(args.path);
  if (typeof args.content !== 'string') throw new Error('content must be a string');
  if (args.content.length > TOUR_FILE_MAX_CHARS) throw new Error('The tour is too large to save.');
  const root = fs.realpathSync(worktreePath);
  const folder = path.dirname(path.join(root, relative));
  let realFolder: string;
  try {
    realFolder = fs.realpathSync(folder);
  } catch {
    throw new Error('The folder to save the tour in does not exist.');
  }
  const inside = path.relative(root, realFolder);
  if (realFolder !== folder || inside.startsWith('..') || path.isAbsolute(inside))
    throw new Error('Tours can only be saved inside the worktree.');

  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = numbered(relative, attempt);
    const target = path.join(root, candidate);
    const entry = entryAt(target);
    if (entry === 'other') {
      if (args.replace === true) throw new Error('The saved tour is no longer a regular file.');
      continue;
    }
    if (entry === 'file' && args.replace !== true) continue;
    // A saved tour that is gone was removed on purpose; it is not brought back.
    if (entry === 'missing' && args.replace === true) throw new Error(TOUR_FILE_CHANGED);
    if (entry === 'file' && args.replace === true) {
      // A replace that cannot say what it expects would write over edits blindly.
      if (typeof args.expected !== 'string') throw new Error('expected must be a string');
      if (changed(target, args.expected)) throw new Error(TOUR_FILE_CHANGED);
    }
    atomicWriteFileSync(target, args.content);
    return candidate;
  }
  throw new Error('Too many saved tours share this name. Rename or remove some first.');
}
