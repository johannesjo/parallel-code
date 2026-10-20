/**
 * Finds the transcripts agent CLIs leave on disk and turns them into session
 * records for a given worktree.
 *
 * Nothing here throws outward: a missing directory, an unreadable file or a
 * format that has drifted all resolve to "no sessions", which leaves resume on
 * the positional fallback it used before.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  claudeProjectSlug,
  codexTitleFrom,
  parseClaudeTranscript,
  parseCodexTranscript,
  type SessionRecord,
} from './transcripts.js';

/** Transcripts grow into the megabytes, and everything worth reading sits at
 *  one end or the other: Codex's `session_meta` and opening turns at the head,
 *  Claude's rewritten title and last-prompt lines at the tail. */
const CHUNK_BYTES = 64 * 1024;

/** Codex files are not organised by working directory, so answering "sessions
 *  for this worktree" means opening them. Newest-first with a cap keeps that
 *  bounded; a session older than the last few hundred is not what anyone is
 *  reaching for. */
const MAX_CODEX_FILES = 400;

/**
 * How far into a Codex transcript to look for the user's opening words.
 *
 * Codex's injected preamble pushes the real first turn a few hundred kilobytes
 * in (see `codexTitleFrom`), so `CHUNK_BYTES` never reaches it — without this
 * every Codex row in the picker reads "Session 01a09b37" and there is nothing
 * to choose between them. This window covers the p90 case.
 *
 * Affordable only because it runs *after* the worktree filter: a few dozen
 * files for one task, not the whole `MAX_CODEX_FILES` cap.
 */
const CODEX_TITLE_BYTES = 512 * 1024;
/** Keep repeated scans useful without retaining every transcript ever visited. */
const MAX_CACHE_ENTRIES = MAX_CODEX_FILES * 2;

export interface SessionScanOptions {
  /** Defaults to `~/.claude/projects`. */
  claudeRoot?: string;
  /** Defaults to `~/.codex/sessions`. */
  codexRoot?: string;
  maxCodexFiles?: number;
}

function claudeRootDir(options: SessionScanOptions): string {
  if (options.claudeRoot) return options.claudeRoot;
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects');
}

function codexRootDir(options: SessionScanOptions): string {
  return options.codexRoot ?? path.join(os.homedir(), '.codex', 'sessions');
}

/**
 * Read the head and tail of a file and return its parsed JSON lines.
 *
 * Lines straddling a chunk boundary are dropped rather than repaired — a
 * half-line is not valid JSON, and the fields we want appear on whole lines at
 * one end or the other.
 */
function parseLines(chunks: readonly string[]): unknown[] {
  const entries: unknown[] = [];
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A drifted or truncated line is skipped; the rest of the file still counts.
      }
    }
  }
  return entries;
}

/** Read `length` bytes from `position` and drop the trailing partial line.
 *  Sliced to what was actually read, so a short read cannot leave the buffer's
 *  zero-fill in the string. */
async function readHead(handle: fs.FileHandle, length: number, position: number): Promise<string> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.toString('utf8', 0, bytesRead).replace(/\n[^\n]*$/, '');
}

async function readBoundedEntries(filePath: string, size: number): Promise<unknown[]> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const chunks: string[] = [];
    if (size <= CHUNK_BYTES * 2) {
      chunks.push((await handle.readFile({ encoding: 'utf8' })) as unknown as string);
    } else {
      chunks.push(await readHead(handle, CHUNK_BYTES, 0));
      const tail = Buffer.alloc(CHUNK_BYTES);
      const { bytesRead } = await handle.read(tail, 0, CHUNK_BYTES, size - CHUNK_BYTES);
      // Drop the leading partial line of the tail chunk.
      chunks.push(tail.toString('utf8', 0, bytesRead).replace(/^[^\n]*\n/, ''));
    }
    return parseLines(chunks);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Parsed records keyed by path, invalidated by mtime so a rescan of an
 *  unchanged transcript costs a stat instead of a read. */
const cache = new Map<string, { mtimeMs: number; record: SessionRecord | null }>();

/** Deep-read Codex titles, cached separately because they are fetched for a
 *  subset of the files `cache` holds and cost far more per file. */
const titles = new Map<string, { mtimeMs: number; title: string | undefined }>();

async function codexTitle(filePath: string, mtimeMs: number): Promise<string | undefined> {
  const cached = titles.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.title;

  let handle: fs.FileHandle | undefined;
  let title: string | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    title = codexTitleFrom(parseLines([await readHead(handle, CODEX_TITLE_BYTES, 0)]));
  } catch {
    title = undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  titles.set(filePath, { mtimeMs, title });
  if (titles.size > MAX_CACHE_ENTRIES) {
    const oldest = titles.keys().next().value;
    if (oldest !== undefined) titles.delete(oldest);
  }
  return title;
}

type Parse = (entries: readonly unknown[]) => Omit<SessionRecord, 'updatedAt'> | null;

async function readRecord(filePath: string, parse: Parse): Promise<SessionRecord | null> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    cache.delete(filePath);
    titles.delete(filePath);
    return null;
  }
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.record;

  const entries = await readBoundedEntries(filePath, stat.size);
  const parsed = entries.length > 0 ? parse(entries) : null;
  const record = parsed ? { ...parsed, updatedAt: stat.mtimeMs } : null;
  cache.set(filePath, { mtimeMs: stat.mtimeMs, record });
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return record;
}

async function readDirSorted(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    // Codex nests YYYY/MM/DD, so descending name order is descending date.
    return names.sort().reverse();
  } catch {
    return [];
  }
}

async function scanClaude(cwd: string, options: SessionScanOptions): Promise<SessionRecord[]> {
  const dir = path.join(claudeRootDir(options), claudeProjectSlug(cwd));
  const names = await readDirSorted(dir);
  const records: SessionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const record = await readRecord(path.join(dir, name), (entries) =>
      parseClaudeTranscript(entries, name.slice(0, -'.jsonl'.length)),
    );
    if (record) records.push(record);
  }
  return records;
}

/** Walk `YYYY/MM/DD` newest-first, stopping once enough files are in hand. */
async function collectCodexFiles(root: string, cap: number): Promise<string[]> {
  const files: string[] = [];
  for (const year of await readDirSorted(root)) {
    for (const month of await readDirSorted(path.join(root, year))) {
      for (const day of await readDirSorted(path.join(root, year, month))) {
        const dayDir = path.join(root, year, month, day);
        for (const name of await readDirSorted(dayDir)) {
          if (!name.endsWith('.jsonl')) continue;
          files.push(path.join(dayDir, name));
          if (files.length >= cap) return files;
        }
      }
    }
  }
  return files;
}

async function scanCodex(cwd: string, options: SessionScanOptions): Promise<SessionRecord[]> {
  const files = await collectCodexFiles(
    codexRootDir(options),
    options.maxCodexFiles ?? MAX_CODEX_FILES,
  );
  const records: SessionRecord[] = [];
  for (const file of files) {
    const record = await readRecord(file, parseCodexTranscript);
    // Filtered here as well as in the caller, and for cost rather than for
    // correctness: the title read below is worth doing only for this worktree's
    // sessions, a few dozen files instead of the whole cap.
    if (!record || record.cwd !== cwd) continue;
    // The deep read wins where it found anything: the windowed record's title
    // may have come from the file's tail, making a late prompt look like the
    // session's opening ask.
    records.push({ ...record, title: (await codexTitle(file, record.updatedAt)) ?? record.title });
  }
  return records;
}

/**
 * Sessions both supported CLIs recorded for a working directory, newest first.
 *
 * Claude's own directory layout narrows the search, but the filter below is on
 * the `cwd` each transcript states, for both agents. That is what makes a
 * mis-derived slug harmless: it finds nothing rather than the wrong worktree's
 * sessions, and resuming the wrong conversation is the failure this exists to
 * prevent in the first place.
 */
export async function listSessionsForCwd(
  cwd: string,
  options: SessionScanOptions = {},
): Promise<SessionRecord[]> {
  const [claude, codex] = await Promise.all([scanClaude(cwd, options), scanCodex(cwd, options)]);
  return [...claude, ...codex]
    .filter((record) => record.cwd === cwd)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Drop memoised records. Exported for tests, which reuse paths across cases. */
export function clearSessionCache(): void {
  cache.clear();
  titles.clear();
}
