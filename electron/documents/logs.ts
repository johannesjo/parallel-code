/**
 * What a one-shot candidate printed, kept on disk so the output can be read
 * after the run finished or the app restarted. Logs live under
 * `.parallel/logs/` in the project, git-excluded: they are local output, not
 * part of the record that travels with the repository.
 */
import fs from 'fs';
import path from 'path';
import { appendGitInfoExcludeBlock } from '../ipc/git-exclude.js';

const LOGS_DIR = path.join('.parallel', 'logs');
const EXCLUDE_HEADER = '# parallel-code: document run output';
const EXCLUDE_PATTERN = '/.parallel/logs/';
/** Longest log handed back to the renderer; the tail is what matters. */
const MAX_READ_CHARS = 2_000_000;

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
export function readCandidateLog(
  projectRoot: string,
  runId: unknown,
  candidateId: unknown,
): string {
  if (typeof runId !== 'string' || typeof candidateId !== 'string') return '';
  try {
    const text = fs.readFileSync(logPath(projectRoot, runId, candidateId), 'utf-8');
    return text.length > MAX_READ_CHARS ? text.slice(-MAX_READ_CHARS) : text;
  } catch {
    return '';
  }
}
