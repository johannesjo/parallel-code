/**
 * What a one-shot candidate printed, kept on disk so the output can be read
 * after the run finished or the app restarted. Logs live under
 * `.parallel/logs/` in the project, git-excluded: they are local output, not
 * part of the record that travels with the repository.
 */
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { appendGitInfoExcludeBlock } from '../ipc/git-exclude.js';

const LOGS_DIR = path.join('.parallel', 'logs');
const EXCLUDE_HEADER = '# parallel-code: document run output';
const EXCLUDE_PATTERN = '/.parallel/logs/';
/** Longest log handed back to the renderer; the tail is what matters. */
const MAX_READ_CHARS = 2_000_000;
// UTF-8 needs at most three bytes per UTF-16 code unit, plus a boundary sequence.
const MAX_READ_BYTES = MAX_READ_CHARS * 3 + 3;

const ID_RE = /^[a-z0-9-]{1,64}$/i;

function logPath(projectRoot: string, runId: string, candidateId: string): string {
  if (!ID_RE.test(runId) || !ID_RE.test(candidateId)) throw new Error('log id is invalid');
  return path.join(projectRoot, LOGS_DIR, runId, `${candidateId}.log`);
}

/** Keeps the logs folder out of the project's `git status`. */
export function ensureDocumentLogsExclude(projectRoot: string): void {
  appendGitInfoExcludeBlock(
    projectRoot,
    EXCLUDE_PATTERN,
    `${EXCLUDE_HEADER}\n${EXCLUDE_PATTERN}\n`,
    (err) => console.warn(`[documents] failed to git-exclude ${EXCLUDE_PATTERN}:`, err),
  );
}

export function appendCandidateLog(
  projectRoot: string,
  runId: string,
  candidateId: string,
  line: string,
): void {
  try {
    const file = logPath(projectRoot, runId, candidateId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
  } catch (err) {
    console.warn('[documents] failed to write candidate log:', err);
  }
}

/** The log so far; empty when the candidate printed nothing (or never ran here). */
export async function readCandidateLog(
  projectRoot: string,
  runId: unknown,
  candidateId: unknown,
): Promise<string> {
  if (typeof runId !== 'string' || typeof candidateId !== 'string') return '';
  let handle: fsPromises.FileHandle | undefined;
  try {
    handle = await fsPromises.open(logPath(projectRoot, runId, candidateId), 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_READ_BYTES);
    const position = size - length;
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    // A tail can begin inside a UTF-8 sequence. Drop its continuation bytes
    // before decoding so the read boundary does not introduce replacement chars.
    let start = 0;
    if (position > 0) {
      while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) start++;
    }
    const text = buffer.toString('utf8', start, bytesRead);
    const tail = text.slice(-MAX_READ_CHARS);
    // The character cap can bisect a surrogate pair, too.
    const first = tail.charCodeAt(0);
    return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
