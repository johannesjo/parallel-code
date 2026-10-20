import fs from 'fs';
import path from 'path';

import { debug } from '../log.js';
import type { FileTourContext } from '../shared/file-tour-context-types.js';
import {
  FILE_TOUR_MAX_FILE_CHARS,
  FILE_TOUR_MAX_IMPORTS,
  FILE_TOUR_MAX_TOTAL_CHARS,
} from '../shared/understanding-limits.js';
import { parseRelativeImports } from './understanding-imports.js';

/** Extensions tried when a specifier has none, or an `/index` file is meant. */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css'];
/** Nothing this large is worth inlining, and reading it would waste memory. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

interface TourFile {
  path: string;
  content: string;
  truncated: boolean;
}

/**
 * Normalize a worktree-relative path, rejecting anything that could escape the
 * worktree. Runs before any filesystem access.
 */
function normalizeRelative(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) throw new Error('filePath must not be empty');
  if (path.isAbsolute(trimmed)) throw new Error('filePath must be relative to the worktree');
  const segments = trimmed.split(/[\\/]/);
  if (segments.includes('..')) throw new Error('filePath must not contain ".."');
  return segments.filter((segment) => segment !== '' && segment !== '.').join('/');
}

function toRelative(worktreeReal: string, absolute: string): string {
  return path.relative(worktreeReal, absolute).split(path.sep).join('/');
}

function isInside(worktreeReal: string, absolute: string): boolean {
  const rel = path.relative(worktreeReal, absolute);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Real path of `candidate` when it is a regular file that stays inside the
 * worktree, otherwise undefined. Symlinks are resolved first so a link pointing
 * out of the worktree is rejected instead of followed.
 */
async function resolveInside(worktreeReal: string, candidate: string): Promise<string | undefined> {
  try {
    const real = await fs.promises.realpath(candidate);
    if (!isInside(worktreeReal, real)) return undefined;
    return (await fs.promises.stat(real)).isFile() ? real : undefined;
  } catch {
    return undefined; // missing candidate — the caller tries the next one
  }
}

async function readCapped(absolute: string): Promise<{ content: string; truncated: boolean }> {
  const stat = await fs.promises.stat(absolute);
  if (stat.size > MAX_READ_BYTES) throw new Error('File is too large to inline');
  const raw = await fs.promises.readFile(absolute, 'utf8');
  if (raw.includes('\0')) throw new Error('File looks binary');
  return raw.length > FILE_TOUR_MAX_FILE_CHARS
    ? { content: raw.slice(0, FILE_TOUR_MAX_FILE_CHARS), truncated: true }
    : { content: raw, truncated: false };
}

/** Candidate paths for one specifier, most likely first. */
function candidatePaths(fromDir: string, spec: string): string[] {
  const base = path.resolve(fromDir, spec);
  const candidates = [base];
  // NodeNext source imports './x.js' while the file on disk is './x.ts'.
  const jsSuffix = /\.js$/.exec(spec);
  if (jsSuffix) {
    candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  }
  for (const ext of EXTENSIONS) candidates.push(`${base}${ext}`);
  for (const ext of EXTENSIONS) candidates.push(path.join(base, `index${ext}`));
  return candidates;
}

async function resolveSpec(
  worktreeReal: string,
  fromDir: string,
  spec: string,
): Promise<string | undefined> {
  for (const candidate of candidatePaths(fromDir, spec)) {
    const resolved = await resolveInside(worktreeReal, candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

/**
 * Context bundle for a file tour: the subject file plus the files it imports
 * directly, all confined to the worktree and bounded by the file-tour caps.
 *
 * `filePath` is worktree-relative; absolute paths, `..` segments and empty
 * values are rejected before any filesystem access.
 */
export async function readFileTourContext(
  worktreePath: string,
  filePath: string,
): Promise<FileTourContext> {
  const relative = normalizeRelative(filePath);
  const worktreeReal = await fs.promises.realpath(worktreePath);

  const subjectReal = await resolveInside(worktreeReal, path.resolve(worktreeReal, relative));
  if (!subjectReal) throw new Error(`Cannot read ${relative} inside this worktree`);

  const subject = await readCapped(subjectReal);
  const subjectRelative = toRelative(worktreeReal, subjectReal);
  const files: TourFile[] = [{ path: subjectRelative, ...subject }];
  /** Import specifiers as written in the source, whatever the reason for omitting them. */
  const omitted: string[] = [];
  const seen = new Set([subjectRelative]);
  let totalChars = subject.content.length;

  const subjectDir = path.dirname(subjectReal);
  for (const spec of parseRelativeImports(subject.content)) {
    if (files.length - 1 >= FILE_TOUR_MAX_IMPORTS) {
      omitted.push(spec);
      continue;
    }
    const resolved = await resolveSpec(worktreeReal, subjectDir, spec);
    if (!resolved) {
      omitted.push(spec);
      continue;
    }
    const importRelative = toRelative(worktreeReal, resolved);
    if (seen.has(importRelative)) continue;
    seen.add(importRelative);

    let imported: { content: string; truncated: boolean };
    try {
      imported = await readCapped(resolved);
    } catch (err) {
      debug('understanding.context', 'skipped import', {
        path: importRelative,
        err: err instanceof Error ? err.message : String(err),
      });
      omitted.push(spec);
      continue;
    }
    if (totalChars + imported.content.length > FILE_TOUR_MAX_TOTAL_CHARS) {
      omitted.push(spec);
      continue;
    }
    files.push({ path: importRelative, ...imported });
    totalChars += imported.content.length;
  }

  return { filePath: relative, files, omitted };
}
